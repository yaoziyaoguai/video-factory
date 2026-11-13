import base64
import json
import os
from pathlib import Path
import sys

PROJECT = Path("/workspace")
SKILLS = Path("/skills")


def controlled_path(value, writable=False):
    candidate = Path(value).resolve()
    roots = [PROJECT] if writable else [PROJECT, SKILLS]
    if not any(candidate == root or candidate.is_relative_to(root) for root in roots):
        raise ValueError("FORBIDDEN: 路径超出当前工程或只读 Skill 区。")
    return candidate


def main():
    request = json.load(sys.stdin)
    action = request["action"]
    if action == "initialize":
        root = Path(request["root"])
        if root not in [PROJECT, SKILLS]:
            raise ValueError("初始化只能作用于固定卷根目录。")
        os.chown(root, 0, 0)
        os.chmod(root, 0o700)
        os.chown(root, request["uid"], request["gid"])
        return {}
    if action == "skills":
        for source in request["files"]:
            file = controlled_path(str(SKILLS / source["path"]))
            if not file.is_relative_to(SKILLS):
                raise ValueError("Skill 副本路径超出只读资源区。")
            file.parent.mkdir(parents=True, exist_ok=True)
            try:
                with file.open("xb") as stream:
                    stream.write(base64.b64decode(source["data"], validate=True))
                file.chmod(0o400)
            except FileExistsError:
                # 同一内容摘要的只读副本已经写入时直接复用。
                pass
        return {}
    if action == "list":
        files = []
        for directory, _, names in os.walk(PROJECT, followlinks=False):
            for name in sorted(names):
                file = controlled_path(str(Path(directory) / name))
                if file.is_file():
                    files.append({"path": str(file.relative_to(PROJECT)), "size": file.stat().st_size})
        return {"files": sorted(files, key=lambda file: file["path"])}
    file = controlled_path(request["path"], action in ["write", "mkdir"] or request.get("mode") == "write")
    if action == "mkdir":
        file.mkdir(parents=True, exist_ok=True)
        return {}
    if action == "write":
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(base64.b64decode(request["data"], validate=True))
        return {}
    if action == "access":
        mode = os.R_OK | (os.W_OK if request["mode"] == "write" else 0)
        if not file.is_file() or not os.access(file, mode):
            raise PermissionError("文件不存在或不可按指定模式访问。")
        return {}
    if action == "read":
        return {"data": base64.b64encode(file.read_bytes()).decode("ascii")}
    if action == "image_type":
        with file.open("rb") as stream:
            header = stream.read(16)
        mime = None
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif header.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif header.startswith((b"GIF87a", b"GIF89a")):
            mime = "image/gif"
        elif header.startswith(b"RIFF") and header[8:12] == b"WEBP":
            mime = "image/webp"
        elif header.startswith(b"BM"):
            mime = "image/bmp"
        return {"mimeType": mime}
    raise ValueError("未支持的固定文件动作。")


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
