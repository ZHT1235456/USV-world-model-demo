import argparse
import base64
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright


DATA = Path(__file__).resolve().parent / "data" / "guides"


def unpack(value, dtype, shape):
    return np.frombuffer(base64.b64decode(value), dtype=dtype).reshape(shape)


def capture(url, seeds, seconds, diagnostic, overwrite):
    DATA.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True, args=["--disable-gpu-sandbox"])
        page = browser.new_page()
        page.on("pageerror", lambda error: print(f"Browser error: {error}", flush=True))
        page.goto(url.rstrip("/") + "/training/capture.html", wait_until="networkidle")
        page.wait_for_function("typeof window.captureEpisode === 'function'")
        for index, seed in enumerate(seeds):
            destination = DATA / f"{seed}.npz"
            if destination.exists() and not diagnostic and not overwrite:
                continue
            result = page.evaluate(
                "([seed, seconds, diagnostic]) => captureEpisode(seed, seconds, diagnostic)",
                [seed, seconds, diagnostic and index == 0],
            )
            count = result["count"]
            samples = result["sampleCount"]
            np.savez(
                destination,
                course=result["course"],
                departure=result["departure"],
                frames=unpack(result["frames"], np.uint8, (count, 24, 40, 3)),
                features=unpack(result["features"], "<f4", (count, 12)),
                states=unpack(result["states"], "<f4", (count, 8)),
                samples=unpack(result["samples"], "<i4", (samples,)),
                actions=unpack(result["actions"], "<f4", (samples, 5, 20, 2)),
                futures=unpack(result["futures"], "<f4", (samples, 5, 20, 8)),
            )
            print(
                f"{seed} {result['course']} {result['departure']}: {count} frames, {samples * 5} branches, "
                f"vision {result['valid'] / count:.0%}, position error {result['positionError']:.3f} m, "
                f"heading error {np.degrees(result['headingError']):.2f} deg, {result['elapsed'] / 1000:.2f} s",
                flush=True,
            )
            frame = result["diagnostic"]
            if frame:
                rgb = unpack(frame["pixels"], np.uint8, (96, 160, 3))
                image = Image.fromarray(rgb)
                image.resize((640, 384), Image.Resampling.NEAREST).save(DATA / "sensor.png")
                print(f"First frame pose: {frame['measured']}", flush=True)
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--start", type=int, default=1000)
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--seconds", type=float, default=70)
    parser.add_argument("--diagnostic", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    options = parser.parse_args()
    capture(options.url, range(options.start, options.start + options.count), options.seconds, options.diagnostic, options.overwrite)
