import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
COURSES = ["breakwater", "inlet", "original"]


def summarize(runs):
    rafts = [run["raft"] for run in runs if run["raft"]]
    finishes = [run["finish"] for run in runs if run["finish"]]
    detections = [raft["detection"] for raft in rafts if raft["detection"]]
    first_plans = [run["firstPlan"] for run in runs]
    return {
        "count": len(runs),
        "successes": sum(run["success"] for run in runs),
        "mark_passes": {mark["id"]: sum(run["marks"][i]["passed"] for run in runs)
                        for i, mark in enumerate(runs[0]["marks"])},
        "min_buoy_clearance_m": round(min(mark["clearance"] for run in runs for mark in run["marks"]), 3),
        "min_shore_clearance_m": round(min(run["shoreClearance"] for run in runs), 3),
        "visual_gate_detections": sum(run["gateSight"] is not None for run in runs),
        "raft_detections": len(detections),
        "min_raft_clearance_m": round(min(raft["clearance"] for raft in rafts), 3) if rafts else None,
        "min_raft_detection_lead_m": round(min(detection["ahead"] for detection in detections), 3) if detections else None,
        "avoidance_sides": sorted({detection["side"] for detection in detections}),
        "fastest_gate_crossing_mps": round(max(finish["speed"] for finish in finishes), 3) if finishes else None,
        "min_gate_clearance_m": round(min(finish["clearance"] for finish in finishes), 3) if finishes else None,
        "worker_latency_p95_ms": round(float(np.percentile([ms for run in runs for ms in run["computes"]], 95)), 2),
        "mean_position_error_m": round(float(np.mean([error for run in runs for error in run["poses"]])), 4),
        "max_initial_heading_error_deg": round(max(plan["headingError"] for plan in first_plans), 3),
        "min_initial_guide_points": min(plan["guidePoints"] for plan in first_plans),
    }


def model_hashes():
    return {name: hashlib.sha256((ROOT / "public" / "models" / name).read_bytes()).hexdigest()
            for name in ("observer.onnx", "motion.onnx")}


def evaluate(url, seeds, courses, ablation, reverse):
    hashes = model_hashes()
    result = {"model_sha256": hashes, "reverse_start": reverse, "courses": {},
              "raft_cue_ablation": {}, "guide_ablation": {}}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True, args=["--disable-gpu-sandbox"])
        page = browser.new_page()
        page.on("pageerror", lambda error: print(f"Browser error: {error}", flush=True))
        page.goto(url.rstrip("/") + "/training/capture.html", wait_until="networkidle")
        page.wait_for_function("typeof window.evaluateVoyage === 'function'")
        for course in courses:
            runs = []
            for seed in seeds:
                run = page.evaluate("([id, seed, reverse]) => evaluateVoyage(seed, id, false, {reverse})",
                                    [course, seed, reverse])
                runs.append(run)
                raft, finish = run["raft"], run["finish"]
                print(course, seed, run["success"], round(run["seconds"], 2),
                      [round(mark["clearance"], 2) for mark in run["marks"]],
                      (round(raft["clearance"], 2), raft["detection"]) if raft else None,
                      round(finish["speed"], 3) if finish else None, run["reason"], flush=True)
            result["courses"][course] = {"summary": summarize(runs), "runs": runs}
            print(course, result["courses"][course]["summary"], flush=True)
            if ablation and reverse:
                masked = page.evaluate(
                    "([id, seed]) => evaluateVoyage(seed, id, false, {reverse: true, maskGuides: true})",
                    [course, seeds[0]],
                )
                result["guide_ablation"][course] = {key: masked[key] for key in ("seed", "success", "reason", "firstPlan")}
                print("guide masked", course, result["guide_ablation"][course], flush=True)
            elif ablation and runs[0]["raft"]:
                masked = page.evaluate("([id, seed]) => evaluateVoyage(seed, id, true)", [course, seeds[0]])
                result["raft_cue_ablation"][course] = {key: masked[key] for key in ("seed", "success", "reason", "raft")}
                print("masked", course, result["raft_cue_ablation"][course], flush=True)
        browser.close()
    if model_hashes() != hashes:
        raise RuntimeError("Model weights changed during evaluation")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--start", type=int, default=4100)
    parser.add_argument("--count", type=int, default=12, help="Additional seeds per course, after seed 0")
    parser.add_argument("--course", action="append", choices=COURSES)
    parser.add_argument("--nominal", action="store_true")
    parser.add_argument("--ablation", action="store_true")
    parser.add_argument("--reverse-start", action="store_true")
    args = parser.parse_args()
    seeds = [0] if args.nominal else [0, *range(args.start, args.start + args.count)]
    result = evaluate(args.url, seeds, args.course or COURSES, args.ablation, args.reverse_start)
    name = "shared-heading-evaluation.json" if args.reverse_start else "shared-nominal.json" if args.nominal else "shared-evaluation.json"
    output = ROOT / "artifacts" / name
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")

    for group in result["courses"].values():
        for run in group["runs"]:
            if not run["success"]:
                raise SystemExit("At least one closed-loop voyage failed")
            if run["shoreClearance"] <= 0 or not run["gateSight"] or run["gateSight"]["ahead"] <= 0:
                raise SystemExit("The hull touched the channel boundary or the camera did not recognize the gate before crossing")
            if args.reverse_start and (run["firstPlan"]["guidePoints"] < 2 or run["firstPlan"]["headingError"] > 5):
                raise SystemExit("Reverse launch did not identify its heading from arrow guides before the first command")
            if run["raft"]:
                raft = run["raft"]
                if not raft["detection"] or raft["detection"]["side"] * raft["crossing"] <= 0:
                    raise SystemExit("Visual raft tracking or planned avoidance was not verified")
    if any(run["raft"]["detection"] for run in result["raft_cue_ablation"].values()):
        raise SystemExit("Planner detected a raft with its visual cue masked")
    if any(run["firstPlan"]["guidePoints"] > 0 for run in result["guide_ablation"].values()):
        raise SystemExit("Planner detected arrow guides while their images were hidden")


if __name__ == "__main__":
    main()
