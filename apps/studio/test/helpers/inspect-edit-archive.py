"""用标准文件读取器，从导出的时间线反算源入点和目标区间，单位为毫秒。"""
import hashlib
import json
import os
import subprocess
import sys
from fractions import Fraction
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from xml.etree import ElementTree
from zipfile import ZipFile

archive, kind, raw_duration, raw_voice, *flags = sys.argv[1:]
duration, voice_length = int(raw_duration), int(raw_voice)
fps = 24
expected = [
    [(0, duration / 2 + 100, duration / 2), (duration / 2, 100, duration / 2)],
    [(0, 0, voice_length)],
    [(t, 0, min(2000, duration - t)) for t in range(0, duration, 2000)],
]
native = "--native" in flags
def fcp_ms(value):
    return float(Fraction(value.removesuffix("s")) * 1000)
def us(r):
    return r["start"] / 1000, r["duration"] / 1000
with TemporaryDirectory() as directory, ZipFile(archive) as z:
    names = z.namelist()
    assert len(names) == len(set(names))
    assert all(not PurePosixPath(n).is_absolute() and ".." not in PurePosixPath(n).parts and "\\" not in n for n in names)
    assert "ATTRIBUTION.txt" in names
    z.extractall(directory)
    root = Path(directory)
    header = root / "Frame.fcpxmld" if kind == "fcpxml" else root
    params = json.loads((header / "Frame-timeline.json").read_text())
    if "--mixed-rate" in flags:
        doc = header / "Info.fcpxml"
        if os.environ.get("FRAME_TEST_FCPXML_DTD"):
            subprocess.run(["xmllint", "--noout", "--dtdvalid", os.environ["FRAME_TEST_FCPXML_DTD"], str(doc)], check=True)
        tree = ElementTree.parse(doc)
        assert tree.getroot().get("version") == "1.10"
        fcp_time = lambda value: Fraction(value.removesuffix("s"))
        rates = {row.get("id"): fcp_time(row.get("frameDuration")) for row in tree.findall(".//format")}
        assets = {row.get("name"): row.attrib for row in tree.findall(".//asset")}
        source, still = [assets[name] for name in ("视频源-30fps", "静帧源")]
        assert rates["f0"] == Fraction(1, 24)
        assert rates[source["format"]] == Fraction(1, 30)
        assert fcp_time(source["duration"]) / rates[source["format"]] == 31
        assert (still["duration"], still["hasVideo"], still["hasAudio"]) == ("3600s", "1", "0")
        assert len(tree.findall(".//spine/asset-clip")) == 2
        gap = tree.find(".//spine/gap")
        assert gap is not None
        tail = gap.findall("asset-clip")
        assert [c.get("lane") for c in tail] == ["-1", "-2", "-2"]
        assert len(tree.findall(".//asset-clip[@lane]")) == 3
        assert all(0 <= fcp_time(c.get("offset")) < fcp_time(gap.get("duration")) for c in tail)
        assert tail[-1].find(".//fadeOut") is not None
        print(json.dumps({"sourceRate": 30, "sequenceRate": 24, "sourceFrames": 31,
                          "stillDurationSeconds": 3600, "tailAudioClips": len(tail)}))
        sys.exit()
    assert params["fps"] == fps and params["music"][0]["duck"] and params["music"][0]["fadeIn"] == 30
    gains = [params[k][0]["gain"] for k in ("visual","narration","music")]
    # 输入视频经 -an 生成，正式受理时已把无音轨素材的原声冻结为零。
    assert gains == [0,0.92,0.18], gains
    clip_files = {segment["media"] for k in ("visual","narration","music") for segment in params[k]}
    assert len(clip_files) == 3
    for filename in clip_files:
        media = header / filename
        with media.open("rb") as source:
            assert hashlib.file_digest(source,"sha256").hexdigest() == media.stem
    if kind == "fcpxml":
        doc = header / "Info.fcpxml"
        if native:
            subprocess.run(["xmllint","--noout","--dtdvalid",os.environ["FRAME_TEST_FCPXML_DTD"],str(doc)],check=True)
        tree = ElementTree.parse(doc)
        assert tree.getroot().get("version") == "1.10"
        v=tree.findall(".//spine/asset-clip")
        read=lambda c:(fcp_ms(c.attrib["offset"]),fcp_ms(c.attrib["start"]),fcp_ms(c.attrib["duration"]))
        actual=[[read(c) for c in v]]
        for lane in ("-1","-2"):
            actual.append([(at-fcp_ms(parent.attrib["start"])+fcp_ms(parent.attrib["offset"]),src,length) for parent in v for at,src,length in map(read,parent.findall(f"asset-clip[@lane='{lane}']"))])
        assert {m.attrib["src"] for m in tree.findall(".//media-rep")} == clip_files
        assert tree.find(".//fadeIn") is not None and tree.find(".//fadeOut") is not None
    elif kind == "otio":
        doc=header/"Frame.otio"
        if native:
            import opentimelineio as otio
            timeline=otio.adapters.read_from_file(str(doc))
            actual=[[(track.range_of_child(c).start_time.to_seconds()*1000,c.source_range.start_time.to_seconds()*1000,c.source_range.duration.to_seconds()*1000) for c in track if isinstance(c,otio.schema.Clip)] for track in timeline.tracks]
            assert {c.media_reference.target_url for c in timeline.find_clips()} == clip_files
        else:
            raw=json.loads(doc.read_text())
            actual=[]
            for track in raw["tracks"]["children"]:
                start=0
                items=[]
                for child in track["children"]:
                    s=child["source_range"]
                    length=s["duration"]["value"]*1000/fps
                    if child["OTIO_SCHEMA"]=="Clip.2":
                        items.append((start,s["start_time"]["value"]*1000/fps,length))
                    start+=length
                actual.append(items)
    else:
        if native:
            from pyJianYingDraft import DraftFolder
            project=DraftFolder(str(root.parent)).load_template(root.name)
            assert len(project.imported_tracks)==3 and project.duration==duration*1000
            raw=json.loads(project.dumps())
        else:
            raw=json.loads((root/"draft_content.json").read_text())
        actual=[[(us(c["target_timerange"])[0],us(c["source_timerange"])[0],us(c["target_timerange"])[1]) for c in tr["segments"]] for tr in raw["tracks"]]
        assert {m["path"] for k in ("audios","videos") for m in raw["materials"][k]}==clip_files
        assert [f["fade_in_duration"] for f in raw["materials"]["audio_fades"]][0]==30000
    assert [len(t) for t in actual] == [len(t) for t in expected], (actual,expected)
    errors=[abs(a-b)*fps/1000 for track,want in zip(actual,expected) for row,ref in zip(track,want) for a,b in zip(row,ref)]
    assert max(errors)<=1, (kind,actual,expected,errors)
    print(json.dumps({"format":kind,"nativeReader":native,"clips":[len(t) for t in actual],"verifiedMediaDigests":len(clip_files),"maxErrorFrames":round(max(errors),4),"durationMs":duration}))

