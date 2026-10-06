"""A stand-in for the DigitalOcean Spaces S3 calls deploy/spaces.py makes
(virtual-hosted: <bucket>.<region>.digitaloceanspaces.com): create, HEAD,
list (v2, paged), multi-object delete, list and abort multipart uploads,
and delete. A request must carry a SigV4 Authorization whose access key is
a Spaces key FakeDigitalOcean issued. The fake re-computes the signature
from the request as received, with its own canonicalization and the secret
in `do.keys`, and the key's grants must cover the bucket.

Knobs: `foreign` (buckets another account owns: PUT gives 409
BucketAlreadyExists, anything else 403), `recreate_conflict` (re-creating
your own bucket gives BucketAlreadyExists, as Spaces does, instead of
BucketAlreadyOwnedByYou), `undeletable` (keys a multi-delete reports as a
per-key AccessDenied with HTTP 200), `cors_needs_fullaccess` (a bucket-scoped
key gets AccessDenied on ?cors) and `down`. `cors` holds each bucket's CORS
rules as dicts."""

import base64
import hashlib
import hmac
import itertools
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape

import httpx

NS = "http://s3.amazonaws.com/doc/2006-03-01/"
_AUTH_RE = re.compile(r"AWS4-HMAC-SHA256 Credential=([^/,]+)/(\d{8})/([a-z0-9-]+)/s3/aws4_request, "
                      r"SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$")
_HOST_RE = re.compile(r"^([a-z0-9-]+)\.([a-z0-9-]+)\.digitaloceanspaces\.com$")


def _xml_error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, content=f"<Error><Code>{code}</Code></Error>".encode(),
                          headers={"content-type": "application/xml"})


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _canonical_query(raw: bytes) -> str:
    """Decode the query as sent, then re-encode each part (RFC 3986), sorted."""
    pairs = []
    for part in raw.decode().split("&") if raw else []:
        name, _, value = part.partition("=")
        pairs.append((quote(unquote(name), safe="-_.~"), quote(unquote(value), safe="-_.~")))
    return "&".join(f"{n}={v}" for n, v in sorted(pairs))


class FakeSpaces:
    def __init__(self, do_fake):
        self.do = do_fake
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.uploads: dict[str, dict[str, str]] = {}  # bucket -> {upload id: key}
        self.requests: list[httpx.Request] = []
        self.page_size = 1000
        self.down = False
        self.foreign: set[str] = set()
        self.recreate_conflict = False
        self.undeletable: set[str] = set()
        self.cors: dict[str, list[dict]] = {}
        self.cors_needs_fullaccess = False
        self._ids = itertools.count(1)

    def put(self, bucket: str, key: str, data: bytes) -> None:
        self.buckets.setdefault(bucket, {})[key] = data

    def start_upload(self, bucket: str, key: str) -> str:
        upload_id = f"upload-{next(self._ids):04d}"
        self.uploads.setdefault(bucket, {})[upload_id] = key
        return upload_id

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _signature_ok(self, request: httpx.Request, region: str, auth: re.Match) -> bool:
        access_key, date, scope_region, signed, signature = auth.groups()
        key = self.do.keys.get(access_key)
        amz_date = request.headers.get("x-amz-date", "")
        sent_hash = request.headers.get("x-amz-content-sha256", "")
        if (key is None or scope_region != region or not amz_date.startswith(date)
                or sent_hash != hashlib.sha256(request.content).hexdigest()):
            return False
        names = signed.split(";")
        if not {"host", "x-amz-date", "x-amz-content-sha256"} <= set(names):
            return False
        if any(n not in request.headers for n in names):
            return False
        raw_path, _, raw_query = request.url.raw_path.partition(b"?")
        block = "".join(f"{n}:{' '.join(request.headers[n].split())}\n" for n in names)
        canonical = "\n".join([request.method, raw_path.decode(), _canonical_query(raw_query),
                               block, signed, sent_hash])
        scope = f"{date}/{region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope,
                             hashlib.sha256(canonical.encode()).hexdigest()])
        k = _hmac(("AWS4" + key["secret_key"]).encode(), date)
        for part in (region, "s3", "aws4_request"):
            k = _hmac(k, part)
        expected = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    def _allowed(self, access_key: str, bucket: str) -> bool:
        key = self.do.keys[access_key]
        return any(g["permission"] == "fullaccess" or g["bucket"] == bucket for g in key["grants"])

    def _cors(self, request: httpx.Request, bucket: str, access_key: str) -> httpx.Response:
        if bucket in self.foreign or not self._allowed(access_key, bucket):
            return _xml_error(403, "AccessDenied")
        if bucket not in self.buckets:
            return _xml_error(404, "NoSuchBucket")
        full = any(g["permission"] == "fullaccess" for g in self.do.keys[access_key]["grants"])
        if self.cors_needs_fullaccess and not full:
            return _xml_error(403, "AccessDenied")
        if request.method == "GET":
            if bucket not in self.cors:
                return _xml_error(404, "NoSuchCORSConfiguration")
            body = [f'<CORSConfiguration xmlns="{NS}">']
            for r in self.cors[bucket]:
                body.append("<CORSRule>")
                for tag, k in (("AllowedOrigin", "origins"), ("AllowedMethod", "methods"),
                               ("AllowedHeader", "headers"), ("ExposeHeader", "expose")):
                    body += [f"<{tag}>{escape(v)}</{tag}>" for v in r[k]]
                body.append(f"<MaxAgeSeconds>{r['max_age']}</MaxAgeSeconds></CORSRule>")
            body.append("</CORSConfiguration>")
            return httpx.Response(200, content="".join(body).encode())
        if request.method == "PUT":
            md5 = base64.b64encode(hashlib.md5(request.content).digest()).decode()
            if request.headers.get("content-md5") != md5:
                return _xml_error(400, "InvalidDigest")
            root = ET.fromstring(request.content)

            def texts(el, tag):
                return [(e.text or "").strip() for e in el if e.tag.rsplit("}", 1)[-1] == tag]
            rules = []
            for el in root:
                if el.tag.rsplit("}", 1)[-1] != "CORSRule":
                    continue
                age = texts(el, "MaxAgeSeconds")
                rules.append({"origins": texts(el, "AllowedOrigin"),
                              "methods": texts(el, "AllowedMethod"),
                              "headers": texts(el, "AllowedHeader"),
                              "expose": texts(el, "ExposeHeader"),
                              "max_age": int(age[0]) if age else 0})
            self.cors[bucket] = rules
            return httpx.Response(200)
        return _xml_error(405, "MethodNotAllowed")

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        host = _HOST_RE.match(request.url.host)
        if host is None:
            return _xml_error(400, "InvalidRequest")
        bucket, region = host.groups()
        auth = _AUTH_RE.match(request.headers.get("authorization", ""))
        if auth is None or auth.group(1) not in self.do.keys:
            return _xml_error(403, "AccessDenied")
        if not self._signature_ok(request, region, auth):
            return _xml_error(403, "SignatureDoesNotMatch")
        method, path, params = request.method, request.url.path, request.url.params
        if path == "/" and "cors" in params:
            return self._cors(request, bucket, auth.group(1))
        if path == "/" and method == "PUT":
            if bucket in self.foreign:
                return _xml_error(409, "BucketAlreadyExists")
            if not self._allowed(auth.group(1), bucket):
                return _xml_error(403, "AccessDenied")
            if bucket in self.buckets:
                return _xml_error(409, "BucketAlreadyExists" if self.recreate_conflict
                                  else "BucketAlreadyOwnedByYou")
            self.buckets[bucket] = {}
            return httpx.Response(200)
        if bucket in self.foreign or not self._allowed(auth.group(1), bucket):
            return _xml_error(403, "AccessDenied")
        if bucket not in self.buckets:
            return _xml_error(404, "NoSuchBucket")
        objects = self.buckets[bucket]
        uploads = self.uploads.setdefault(bucket, {})
        if path == "/" and method == "HEAD":
            return httpx.Response(200)
        if path == "/" and method == "GET" and params.get("list-type") == "2":
            keys = sorted(objects)
            start = int(params.get("continuation-token") or 0)
            page = keys[start:start + self.page_size]
            more = start + self.page_size < len(keys)
            body = [f'<ListBucketResult xmlns="{NS}"><IsTruncated>{str(more).lower()}'
                    "</IsTruncated>"]
            body += [f"<Contents><Key>{escape(k)}</Key><Size>{len(objects[k])}</Size></Contents>"
                     for k in page]
            if more:
                body.append(f"<NextContinuationToken>{start + self.page_size}"
                            "</NextContinuationToken>")
            body.append("</ListBucketResult>")
            return httpx.Response(200, content="".join(body).encode())
        if path == "/" and method == "GET" and "uploads" in params:
            page = sorted(uploads.items())[:self.page_size]
            more = len(uploads) > self.page_size
            body = [f'<ListMultipartUploadsResult xmlns="{NS}">'
                    f"<IsTruncated>{str(more).lower()}</IsTruncated>"]
            body += [f"<Upload><Key>{escape(k)}</Key><UploadId>{u}</UploadId></Upload>"
                     for u, k in page]
            body.append("</ListMultipartUploadsResult>")
            return httpx.Response(200, content="".join(body).encode())
        if path == "/" and method == "POST" and "delete" in params:
            md5 = base64.b64encode(hashlib.md5(request.content).digest()).decode()
            if request.headers.get("content-md5") != md5:
                return _xml_error(400, "InvalidDigest")
            root = ET.fromstring(request.content)
            quiet = (root.findtext("Quiet") or "").strip() == "true"
            body = [f'<DeleteResult xmlns="{NS}">']
            for key in root.iter("Key"):
                name = key.text or ""
                if name in self.undeletable:
                    body.append(f"<Error><Key>{escape(name)}</Key><Code>AccessDenied</Code>"
                                "<Message>Access Denied</Message></Error>")
                    continue
                objects.pop(name, None)
                if not quiet:
                    body.append(f"<Deleted><Key>{escape(name)}</Key></Deleted>")
            body.append("</DeleteResult>")
            return httpx.Response(200, content="".join(body).encode())
        if path != "/" and method == "DELETE" and "uploadId" in params:
            if uploads.get(params["uploadId"]) != path[1:]:
                return _xml_error(404, "NoSuchUpload")
            del uploads[params["uploadId"]]
            return httpx.Response(204)
        if path == "/" and method == "DELETE":
            if objects or uploads:
                return _xml_error(409, "BucketNotEmpty")
            del self.buckets[bucket]
            self.uploads.pop(bucket, None)
            return httpx.Response(204)
        return _xml_error(405, "MethodNotAllowed")
