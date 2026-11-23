import base64
import json
import os
from pathlib import Path
import sys

PROJECT = Path("/workspace")
SKILLS = Path("/skills")


def controlled_path(value, writable=False):
    candidate = Path(value).resolve()
    roots = [PROJECT] if writable or Path(value).is_relative_to(PROJECT) else [PROJECT, SKILLS]
    if not any(candidate == root or candidate.is_relative_to(root) for root in roots):
        raise ValueError("FORBIDDEN: 路径超出当前工程或只读 Skill 区。")
    return candidate


def handle(request):
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
            # 完整写入同目录临时文件并原子替换：中断只可能留下临时残片，最终路径要么
            # 没有文件、要么是完整内容；重试不会把半截文件当成已同步（R9）。
            temporary = file.with_name(file.name + ".partial")
            try:
                with temporary.open("wb") as stream:
                    stream.write(base64.b64decode(source["data"], validate=True))
                os.chmod(temporary, 0o400)
                os.replace(temporary, file)
            except BaseException:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
                raise
        return {}
    if action == "list":
        files = []
        for directory, _, names in os.walk(PROJECT, followlinks=False):
            for name in sorted(names):
                file = Path(directory) / name
                if file.is_symlink() and not Path(os.path.realpath(file)).is_relative_to(PROJECT):
                    continue
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


def main():
    # 每行一个请求：宿主以长驻温热容器复用同一进程，EOF 即退出。
    # 单请求 + 关闭 stdin 的旧调用方式等价于一次循环，保持兼容。
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = handle(json.loads(line))
        except Exception as error:
            # 温热进程按请求隔离失败：单次路径/权限错误回复后继续服务，
            # 不让容器退出迫使宿主回退冷启动。
            reply = {"error": str(error)}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


main()
