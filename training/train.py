import argparse
import copy
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F


ROOT = Path(__file__).resolve().parents[1]
HISTORY = 20
HORIZON = 20


class Corpus:
    def __init__(self, first_seed):
        paths = sorted(path for path in (ROOT / "training" / "data" / "guides").glob("*.npz")
                       if path.stem.isdecimal() and first_seed <= int(path.stem) < first_seed + 1000)
        if not paths:
            raise FileNotFoundError(f"No collected voyages in seed range {first_seed}–{first_seed + 999}")
        self.seeds = [int(path.stem) for path in paths]
        self.courses = set()
        self.departures = Counter()
        frames, features, states, indices, anchors, actions, futures = [], [], [], [], [], [], []
        start = 0
        for path in paths:
            with np.load(path) as data:
                self.courses.add(str(data["course"].item()))
                self.departures[str(data["departure"].item())] += 1
                count = len(data["frames"])
                frames.append(data["frames"])
                features.append(data["features"])
                states.append(data["states"])
                indices.extend(range(start + HISTORY - 1, start + count, 3))
                anchors.extend((data["samples"] + start).tolist())
                actions.append(data["actions"])
                futures.append(data["futures"])
                start += count
        self.frames = torch.from_numpy(np.concatenate(frames))
        self.features = torch.from_numpy(np.concatenate(features))
        self.states = torch.from_numpy(np.concatenate(states))
        self.indices = torch.tensor(indices)
        self.anchors = torch.tensor(anchors)
        self.actions = torch.from_numpy(np.concatenate(actions))
        self.futures = torch.from_numpy(np.concatenate(futures))
        self.offsets = torch.arange(1 - HISTORY, 1)

    def batch(self, indices):
        window = indices[:, None] + self.offsets
        return self.frames[window], self.features[window], self.states[indices]


class Observer(nn.Module):
    def __init__(self, visual=True):
        super().__init__()
        self.visual = visual
        if visual:
            self.vision = nn.Sequential(
                nn.Conv2d(3, 8, kernel_size=5, stride=2, padding=2),
                nn.SiLU(),
                nn.Conv2d(8, 12, kernel_size=3, stride=2, padding=1),
                nn.SiLU(),
                nn.AvgPool2d(2),
                nn.Flatten(),
                nn.Linear(12 * 3 * 5, 22),
                nn.Tanh(),
            )
        self.temporal = nn.GRU((22 + 12) if visual else 5, 42, batch_first=True)
        self.output = nn.Sequential(nn.Linear(42, 42), nn.SiLU(), nn.Linear(42, 8))
        if visual:
            self.register_buffer("pose_scale", torch.tensor([38.0, 6.0, 1.0]))
            self.register_buffer("pose_adjust", torch.tensor([0.26, 0.24, 0.055]))
        else:
            self.register_buffer("pose_scale", torch.tensor([38.0, 6.0, 1.0]))

    def forward(self, pixels, history):
        last = history[:, -1]
        if self.visual:
            windows = pixels.reshape(-1, 24, 40, 3).permute(0, 3, 1, 2).float() / 255
            encoded = self.vision(windows).reshape(history.shape[0], HISTORY, 22)
            anchor = last[:, :3] * self.pose_scale
            cosine, sine = torch.cos(anchor[:, 2:3]), torch.sin(anchor[:, 2:3])
            offset = history[:, :, :3] * self.pose_scale - anchor[:, None]
            along = (offset[:, :, 0] * cosine + offset[:, :, 1] * sine) / 4
            across = (-offset[:, :, 0] * sine + offset[:, :, 1] * cosine) / 2
            relative = torch.stack((along, across, torch.sin(offset[:, :, 2])), dim=2)
            age = (history[:, :, 11:12] - last[:, None, 11:12]) * 19
            sequence = torch.cat((encoded, relative, history[:, :, 3:11], age), dim=2)
        else:
            sequence = torch.cat((history[:, :, 6:10], history[:, :, 11:12]), dim=2)
        context, _ = self.temporal(sequence)
        estimate = self.output(context[:, -1])
        if self.visual:
            adjustment = torch.tanh(estimate[:, :3]) * self.pose_adjust
            along, across, turn = adjustment.unbind(dim=1)
            c, s = cosine[:, 0], sine[:, 0]
            pose = anchor + torch.stack((along * c - across * s, along * s + across * c, turn), dim=1)
        else:
            pose = estimate[:, 0:3] * self.pose_scale
        normalized_rpm = last[:, 6]
        steady = (torch.sqrt(0.27 ** 2 + 4 * 0.14 * 1.8 * normalized_rpm.square()) - 0.27) / 0.28
        speed = torch.clamp(steady + 0.85 * torch.tanh(estimate[:, 3]), 0.0, 3.0)
        sway = 0.43 * torch.tanh(estimate[:, 4])
        yaw = 0.68 * torch.tanh(estimate[:, 5])
        rpm = 2400 * normalized_rpm + 145 * torch.tanh(estimate[:, 6])
        rudder = 35 * last[:, 7] + 4.5 * torch.tanh(estimate[:, 7])
        return torch.cat((pose, torch.stack((speed, sway, yaw, rpm, rudder), dim=1)), dim=1)


class Motion(nn.Module):
    """A fitted recurrent transition with surge, sway and yaw coupling."""

    def __init__(self):
        super().__init__()
        self.coefficients = nn.Parameter(torch.tensor([1.67, 0.25, 0.15, 0.15, 1.51, 0.31, 0.88, 1.39, 0.39]))

    def forward(self, state, command):
        north, east, heading, surge, sway, yaw, rpm, rudder = state.unbind(dim=1)
        target_rpm, target_rudder = command.unbind(dim=1)
        thrust, drag1, drag2, drag_side, sway_damping, sway_force, turn, yaw_damping, turn_drag = self.coefficients.unbind()
        dt = 0.05
        for _ in range(5):
            rpm = rpm + (target_rpm - rpm) * (1 - math.exp(-dt / 0.72))
            rudder = rudder + torch.clamp(target_rudder - rudder, -42 * dt, 42 * dt)
            power = (rpm / 2400).square()
            flow = surge * surge.abs()
            side = (0.65 * flow + 0.25 * power) * torch.sin(rudder * (math.pi / 180))
            forward_force = thrust * power - drag1 * surge - drag2 * flow - drag_side * side.abs() + sway * yaw
            side_force = -sway_damping * sway - sway_force * side - surge * yaw
            turn_force = turn * side - yaw_damping * yaw - turn_drag * yaw * yaw.abs()
            surge = surge + dt * forward_force
            sway = sway + dt * side_force
            yaw = yaw + dt * turn_force
            heading = heading + dt * yaw
            sine, cosine = torch.sin(heading), torch.cos(heading)
            north = north + dt * (surge * cosine - sway * sine)
            east = east + dt * (surge * sine + sway * cosine)
        return torch.stack((north, east, heading, surge, sway, yaw, rpm, rudder), dim=1)


def errors(estimate, truth):
    delta = estimate - truth
    angle = torch.atan2(torch.sin(delta[..., 2:3]), torch.cos(delta[..., 2:3]))
    return torch.cat((delta[..., :2], angle, delta[..., 3:]), dim=-1)


def state_loss(estimate, truth):
    scales = torch.tensor([0.60, 0.55, 0.20, 0.36, 0.14, 0.26, 280.0, 10.0])
    delta = errors(estimate, truth) / scales
    return F.smooth_l1_loss(delta, torch.zeros_like(delta), beta=0.35)


def rollout(motion, state, actions):
    poses = []
    for tick in range(HORIZON):
        state = motion(state, actions[:, tick])
        poses.append(state)
    return torch.stack(poses, dim=1)


def fit_motion(motion, train):
    commands = train.actions.reshape(-1, 20, 2)
    futures = train.futures.reshape(-1, 20, 8)
    starts = train.states[train.anchors].repeat_interleave(5, dim=0)
    rows = torch.cat((starts[:, None], futures[:, :-1]), dim=1).reshape(-1, 8)
    targets = futures.reshape(-1, 8)
    flattened = commands.reshape(-1, 2)
    optimizer = torch.optim.Adam(motion.parameters(), lr=0.009)
    for i in range(190):
        batch = torch.randint(len(rows), (768,))
        loss = state_loss(motion(rows[batch], flattened[batch]), targets[batch])
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if i == 120:
            optimizer.param_groups[0]["lr"] *= 0.4
    optimizer = torch.optim.Adam(motion.parameters(), lr=0.001)
    for _ in range(17):
        batch = torch.randint(len(starts), (96,))
        loss = state_loss(rollout(motion, starts[batch], commands[batch]), futures[batch])
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
    print("Fitted motion:", motion.coefficients.detach().tolist(), flush=True)


@torch.no_grad()
def observer_error(model, data):
    errors_sum = 0.0
    for batch in data.indices.split(96):
        pixels, history, target = data.batch(batch)
        errors_sum += len(batch) * state_loss(model(pixels, history), target).item()
    return errors_sum / len(data.indices)


def fit_observer(observer, train, validation, motion, epochs):
    optimizer = torch.optim.AdamW(observer.parameters(), lr=0.0018, weight_decay=0.0001)
    best_error = float("inf")
    best = None
    for epoch in range(epochs):
        batches = train.indices[torch.randperm(len(train.indices))].split(64)
        for batch in batches:
            pixels, history, truth = train.batch(batch)
            loss = state_loss(observer(pixels, history), truth)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(observer.parameters(), 2.0)
            optimizer.step()
        measured = observer_error(observer, validation)
        print(f"{'vision' if observer.visual else 'actions'} epoch {epoch + 1}/{epochs}: {measured:.5f}", flush=True)
        if measured < best_error:
            best_error, best = measured, copy.deepcopy(observer.state_dict())
        if epoch >= epochs // 2:
            optimizer.param_groups[0]["lr"] = max(0.00045, optimizer.param_groups[0]["lr"] * 0.86)
    observer.load_state_dict(best)
    if not observer.visual:
        return
    motion.requires_grad_(False)
    optimizer = torch.optim.AdamW(observer.parameters(), lr=0.00035)
    for _ in range(45):
        rows = torch.randint(len(train.anchors), (64,))
        arm = torch.randint(5, (len(rows),))
        pixels, history, truth = train.batch(train.anchors[rows])
        estimate = observer(pixels, history)
        future = rollout(motion, estimate, train.actions[rows, arm])
        loss = state_loss(estimate, truth) + 0.65 * state_loss(future, train.futures[rows, arm])
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(observer.parameters(), 1.5)
        optimizer.step()


@torch.no_grad()
def assess(observer, data, motion):
    ade, fde, heading, count = 0.0, 0.0, 0.0, 0
    for indices in torch.arange(len(data.anchors)).split(64):
        pixels, history, truth = data.batch(data.anchors[indices])
        start = observer(pixels, history) if observer else truth
        result = rollout(motion, start.repeat_interleave(5, dim=0), data.actions[indices].reshape(-1, HORIZON, 2))
        delta = errors(result, data.futures[indices].reshape(-1, HORIZON, 8))
        distance = delta[..., :2].norm(dim=2)
        ade += distance.mean(dim=1).sum().item()
        fde += distance[:, -1].sum().item()
        heading += delta[:, -1, 2].abs().sum().item()
        count += len(distance)
    return {"ade": round(ade / count, 4), "fde": round(fde / count, 4),
            "heading": round(math.degrees(heading / count), 3), "branches": count}


def export_model(model, inputs, path, input_names, output_name, dynamic_axes=None):
    model.eval()
    torch.onnx.export(model, inputs, str(path), input_names=input_names, output_names=[output_name],
                      opset_version=17, dynamo=False, dynamic_axes=dynamic_axes, external_data=False)
    return check_export(model, inputs, path, input_names)


def check_export(model, inputs, path, input_names):
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 2
    runtime = ort.InferenceSession(str(path), session_options, providers=["CPUExecutionProvider"])
    reference = model(*inputs).detach().numpy()
    arrays = dict(zip(input_names, (tensor.numpy() for tensor in inputs)))
    actual, = runtime.run(None, {item.name: arrays[item.name] for item in runtime.get_inputs()})
    error = float(np.max(np.abs(actual - reference)))
    if not np.allclose(actual, reference, rtol=1e-3, atol=3e-5):
        raise ValueError(f"ONNX parity failed for {path.name}: {error}")
    return error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--threads", type=int, default=5)
    parser.add_argument("--reuse-motion", action="store_true", help="Keep the trained dynamics and its existing ONNX export")
    options = parser.parse_args()
    torch.manual_seed(41)
    torch.set_num_threads(options.threads)
    train, validation, test = Corpus(1000), Corpus(2000), Corpus(3000)
    if (train.courses | validation.courses) & test.courses:
        raise ValueError("Held-out course layouts overlap fitting or validation data")
    print(f"Voyages train/validation/test = {len(train.seeds)}/{len(validation.seeds)}/{len(test.seeds)}", flush=True)
    print(f"Training departures: {dict(train.departures)}", flush=True)
    assets = ROOT / "public" / "models"
    checkpoints = ROOT / "training" / "checkpoints"
    checkpoint_path = checkpoints / "world-model.pt"
    motion_inputs = (train.states[:4], train.actions[0, :4, 0])
    motion_path = assets / "motion.onnx"
    motion = Motion()
    if options.reuse_motion:
        previous = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        motion.load_state_dict(previous["motion"])
        motion.eval()
        motion_parity = check_export(motion, motion_inputs, motion_path, ["state", "cmd"])
    else:
        fit_motion(motion, train)
    observer = Observer()
    fit_observer(observer, train, validation, motion, options.epochs)
    baseline = Observer(visual=False)
    fit_observer(baseline, train, validation, motion, options.epochs)
    metrics = {"vision": assess(observer, test, motion), "actions": assess(baseline, test, motion),
               "known_state": assess(None, test, motion)}
    print(json.dumps(metrics, ensure_ascii=False), flush=True)

    assets.mkdir(parents=True, exist_ok=True)
    checkpoints.mkdir(parents=True, exist_ok=True)
    indices = test.anchors[:1]
    pixels, history, _ = test.batch(indices)
    observer_parity = export_model(observer, (pixels, history), assets / "observer.onnx", ["pixels", "history"], "state")
    if not options.reuse_motion:
        motion_parity = export_model(
            motion, motion_inputs, motion_path, ["state", "cmd"], "next",
            dynamic_axes={"state": {0: "batch"}, "cmd": {0: "batch"}, "next": {0: "batch"}},
        )
    export_model(baseline, (pixels, history), checkpoints / "actions.onnx", ["pixels", "history"], "state")
    torch.save({"observer": observer.state_dict(), "motion": motion.state_dict(),
                "actions": baseline.state_dict()}, checkpoint_path)
    manifest = {"version": 3, "training": {"voyages": len(train.seeds), "validation": len(validation.seeds),
                "test": len(test.seeds), "frames": len(train.frames), "branches": int(len(train.anchors) * 5),
                "fitting_courses": sorted(train.courses), "validation_courses": sorted(validation.courses),
                "held_out_courses": sorted(test.courses), "departures": dict(train.departures),
                "motion_reused": options.reuse_motion},
                "metrics": metrics, "onnx_parity": {"observer": observer_parity, "motion": motion_parity}}
    (assets / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Exported observer.onnx; {'kept' if options.reuse_motion else 'exported'} motion.onnx", flush=True)


if __name__ == "__main__":
    main()
