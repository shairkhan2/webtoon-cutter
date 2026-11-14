"""Reference detections from imgutils for the PNG written by scripts/parity.ts.
Usage: ../.server-venv/Scripts/python.exe scripts/parity.py <window.png>
"""
import sys

from PIL import Image
from imgutils.detect import detect_heads, detect_person
from imgutils.ocr.detect import _detect_text

im = Image.open(sys.argv[1]).convert("RGB")
fmt = lambda r, s=1: [",".join(str(round(v / s)) for v in b) + f" {sc:.2f}" for b, _, sc in r]
print("head", fmt(detect_heads(im, model_name="head_detect_v2.0_n", conf_threshold=0.4, iou_threshold=0.7)))
print("person", fmt(detect_person(im, model_name="person_detect_v1.1_n", conf_threshold=0.35, iou_threshold=0.5)))
half = im.resize((round(im.width * 0.5), round(im.height * 0.5)))
print("text", fmt(_detect_text(half, box_threshold=0.6), 0.5))
