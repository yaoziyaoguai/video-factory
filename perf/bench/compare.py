"""核对同一受控数据的文字与双宽度截图；不忽略失败样本。"""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageChops

parser = argparse.ArgumentParser()
parser.add_argument("before")
parser.add_argument("after")
parser.add_argument("--before-version", default="A")
parser.add_argument("--after-version", default="A")
args = parser.parse_args()
before = json.loads(Path(args.before).read_text())
after = json.loads(Path(args.after).read_text())
for document in (before, after):
    for variants in document["results"].values():
        for result in variants.values():
            assert result["summary"]["n_ok"] == result["summary"]["n"], "测量存在失败"


def entries(document, version):
    return {(g["route"], g["width"]): g for g in document["guards"] if g["version"] == version}


old = entries(before, args.before_version)
new = entries(after, args.after_version)
assert old and old.keys() == new.keys(), "护栏不完整"
for key, a in old.items():
    b = new[key]
    assert a["ok"] and b["ok"], (key, "功能护栏失败")
    assert a["golden"] == b["golden"], (key, "可见文字变化")
    # 图像路径由输出记录相邻文件名定位，不含认证状态。
    route, width = key
    def picture(document, file, version):
        from urllib.parse import urlparse
        port = urlparse(document["results"][route][version]["url"]).port
        return Image.open(f"{file}.{port}-{route}-{width}.png").convert("RGB")
    left = picture(before, args.before, args.before_version)
    right = picture(after, args.after, args.after_version)
    assert left.size == right.size, (key, "页面尺寸变化")
    diff = ImageChops.difference(left, right)
    # 允许极少的媒体原生控件/光栅化噪声，不允许整体字体或布局改变。
    changed = sum(max(pixel) > 20 for pixel in diff.getdata())
    fraction = changed / (left.width * left.height)
    print(f"{route} {width}: text=identical pixel_difference={fraction:.6%}")
    assert fraction <= 0.001, (key, "像素差超过0.1%", fraction)
