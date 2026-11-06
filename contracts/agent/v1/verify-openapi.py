"""离线验证 OpenAPI 文档结构；载荷和本地引用另由 verify.mjs 校验。"""

import hashlib
import json
from importlib.metadata import version
from pathlib import Path

from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent
assert version("jsonschema") == "4.25.1", "Use the pinned validator version"
meta_path = root / "openapi-3.1-meta-20221007.json"
meta_bytes = meta_path.read_bytes()
meta_hash = hashlib.sha256(meta_bytes).hexdigest()
assert meta_hash == "da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0"
meta = json.loads(meta_bytes)
api_bytes = (root / "openapi.json").read_bytes()
api = json.loads(api_bytes)

Draft202012Validator.check_schema(meta)
validator = Draft202012Validator(meta)
errors = [{"path": list(error.path), "message": error.message} for error in validator.iter_errors(api)]
missing_info = dict(api)
missing_info.pop("info")
rejects_missing_info = bool(list(validator.iter_errors(missing_info)))
result = {
    "validator": "python-jsonschema " + version("jsonschema"),
    "schemaUrl": meta["$id"],
    "schemaSha256": meta_hash,
    "documentSha256": hashlib.sha256(api_bytes).hexdigest(),
    "valid": not errors,
    "rejectsMissingInfo": rejects_missing_info,
    "formatAssertions": False,
    "errors": errors,
}
(root / "evidence").mkdir(exist_ok=True)
(root / "evidence/openapi-check.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors) or not rejects_missing_info)
