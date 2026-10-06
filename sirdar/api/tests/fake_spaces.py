"""A stand-in for the DigitalOcean Spaces S3 calls deploy/spaces.py makes
(virtual-hosted: <bucket>.<region>.digitaloceanspaces.com): create, HEAD,
list (v2, paged), multi-object delete and delete. A request must carry a
SigV4 Authorization whose access key is a Spaces key FakeDigitalOcean
issued, and the key's grants must cover the bucket."""

import base64
import hashlib
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

import httpx

NS = "http://s3.amazonaws.com/doc/2006-03-01/"
_CRED_RE = re.compile(r"AWS4-HMAC-SHA256 Credential=([^/]+)/")


def _xml_error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, content=f"<Error><Code>{code}</Code></Error>".encode(),
                          headers={"content-type": "application/xml"})


class FakeSpaces:
    def __init__(self, do_fake):
        self.do = do_fake
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.requests: list[httpx.Request] = []
        self.page_size = 1000
        self.down = False

    def put(self, bucket: str, key: str, data: bytes) -> None:
        self.buckets.setdefault(bucket, {})[key] = data

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _allowed(self, access_key: str, bucket: str) -> bool:
        key = self.do.keys.get(access_key)
        if key is None:
            return False
        return any(g["permission"] == "fullaccess" or g["bucket"] == bucket for g in key["grants"])

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        host = request.url.host
        bucket = host.split(".", 1)[0]
        auth = _CRED_RE.match(request.headers.get("authorization", ""))
        if auth is None or not self._allowed(auth.group(1), bucket):
            return _xml_error(403, "AccessDenied")
        if "x-amz-date" not in request.headers or "x-amz-content-sha256" not in request.headers:
            return _xml_error(400, "AuthorizationHeaderMalformed")
        method, path, params = request.method, request.url.path, request.url.params
        if path == "/" and method == "PUT":
            if bucket in self.buckets:
                return _xml_error(409, "BucketAlreadyOwnedByYou")
            self.buckets[bucket] = {}
            return httpx.Response(200)
        if bucket not in self.buckets:
            return _xml_error(404, "NoSuchBucket")
        objects = self.buckets[bucket]
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
        if path == "/" and method == "POST" and "delete" in params:
            md5 = base64.b64encode(hashlib.md5(request.content).digest()).decode()
            if request.headers.get("content-md5") != md5:
                return _xml_error(400, "InvalidDigest")
            root = ET.fromstring(request.content)
            for key in root.iter("Key"):
                objects.pop(key.text, None)
            return httpx.Response(200, content=f'<DeleteResult xmlns="{NS}"/>'.encode())
        if path == "/" and method == "DELETE":
            if objects:
                return _xml_error(409, "BucketNotEmpty")
            del self.buckets[bucket]
            return httpx.Response(204)
        return _xml_error(405, "MethodNotAllowed")
