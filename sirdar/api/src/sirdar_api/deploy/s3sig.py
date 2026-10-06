"""AWS Signature Version 4 for the few S3 calls Sirdar makes to DigitalOcean
Spaces (deploy phase 7: create, list, empty and delete a bucket). Sirdar has
no boto3: it would bypass the httpx transports tests replace. Pure functions;
the secret only feeds the HMAC chain and is never returned."""

import hashlib
import hmac
from datetime import datetime
from urllib.parse import quote

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
ALGORITHM = "AWS4-HMAC-SHA256"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret_key: str, date: str, region: str, service: str) -> bytes:
    k = _hmac(("AWS4" + secret_key).encode(), date)
    k = _hmac(k, region)
    k = _hmac(k, service)
    return _hmac(k, "aws4_request")


def _encode(value: str) -> str:
    return quote(value, safe="-_.~")


def canonical_query(query: dict[str, str]) -> str:
    return "&".join(f"{_encode(k)}={_encode(v)}" for k, v in sorted(query.items()))


def sign(*, method: str, host: str, path: str, query: dict[str, str], headers: dict[str, str],
         payload_sha256: str, access_key: str, secret_key: str, region: str, now: datetime,
         service: str = "s3") -> dict[str, str]:
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    canon = {k.lower(): " ".join(str(v).split()) for k, v in headers.items()}
    canon |= {"host": host, "x-amz-date": amz_date, "x-amz-content-sha256": payload_sha256}
    names = sorted(canon)
    signed = ";".join(names)
    request = "\n".join([method, quote(path, safe="/-_.~"), canonical_query(query),
                         "".join(f"{n}:{canon[n]}\n" for n in names), signed, payload_sha256])
    scope = f"{date}/{region}/{service}/aws4_request"
    to_sign = "\n".join([ALGORITHM, amz_date, scope,
                         hashlib.sha256(request.encode()).hexdigest()])
    signature = hmac.new(_signing_key(secret_key, date, region, service), to_sign.encode(),
                         hashlib.sha256).hexdigest()
    return {**headers, "x-amz-date": amz_date, "x-amz-content-sha256": payload_sha256,
            "Authorization": f"{ALGORITHM} Credential={access_key}/{scope}, "
                             f"SignedHeaders={signed}, Signature={signature}"}
