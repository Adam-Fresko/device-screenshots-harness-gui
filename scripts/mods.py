#!/usr/bin/env python3
"""Scaffold and check the mods in this repo.

    python3 scripts/mods.py new <app> <name> -d "One line description."
    python3 scripts/mods.py check [--run-claude]

<app> is one of the keys of APPS. Standard library only.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
PLACEHOLDERS = ("__MOD_NAME__", "__DESCRIPTION__", "__DISPLAY_NAME__")
FORBIDDEN_IN_DESCRIPTION = set("\"'`\\\n\r")

APPS = {
    "claude-code": {
        "manifest": ".claude-plugin/plugin.json",
        "marketplace": ".claude-plugin/marketplace.json",
        "entry": lambda name, description: {
            "name": name,
            "source": f"./mods/claude-code/{name}",
            "description": description,
        },
        "source_of": lambda entry: entry.get("source"),
    },
    "codex": {
        "manifest": ".codex-plugin/plugin.json",
        "marketplace": ".agents/plugins/marketplace.json",
        "entry": lambda name, description: {
            "name": name,
            "source": {"source": "local", "path": f"./mods/codex/{name}"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Productivity",
        },
        "source_of": lambda entry: (entry.get("source") or {}).get("path"),
    },
}


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def mod_dirs(app):
    base = ROOT / "mods" / app
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))


def display_name(name):
    return " ".join(part.capitalize() for part in name.split("-"))


def cmd_new(args):
    app, name, description = args.app, args.name, args.description.strip()
    if not NAME_RE.match(name):
        sys.exit(f"error: '{name}' is not kebab-case (e.g. my-mod)")
    if not description or FORBIDDEN_IN_DESCRIPTION & set(description):
        sys.exit("error: description must be one non-empty line without quotes, backticks or backslashes")

    template = ROOT / "templates" / app
    target = ROOT / "mods" / app / name
    if target.exists():
        sys.exit(f"error: {target.relative_to(ROOT)} already exists")

    marketplace_path = ROOT / APPS[app]["marketplace"]
    marketplace = read_json(marketplace_path)
    if any(entry.get("name") == name for entry in marketplace.get("plugins", [])):
        sys.exit(f"error: {name} is already listed in {APPS[app]['marketplace']}")

    values = {
        "__MOD_NAME__": name,
        "__DESCRIPTION__": description,
        "__DISPLAY_NAME__": display_name(name),
    }
    for src in sorted(template.rglob("*")):
        rel = str(src.relative_to(template))
        for key, value in values.items():
            rel = rel.replace(key, value)
        dst = target / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        for key, value in values.items():
            text = text.replace(key, value)
        dst.write_text(text, encoding="utf-8")
        shutil.copymode(src, dst)

    plugins = marketplace.setdefault("plugins", [])
    plugins.append(APPS[app]["entry"](name, description))
    plugins.sort(key=lambda entry: entry["name"])
    write_json(marketplace_path, marketplace)

    print(f"created mods/{app}/{name}/ and listed it in {APPS[app]['marketplace']}")


def check_app(app, problems):
    spec = APPS[app]
    marketplace_rel = spec["marketplace"]
    try:
        marketplace = read_json(ROOT / marketplace_rel)
    except (OSError, json.JSONDecodeError) as err:
        problems.append(f"{marketplace_rel}: {err}")
        return []

    listed = {}
    for entry in marketplace.get("plugins", []):
        name = entry.get("name")
        if name in listed:
            problems.append(f"{marketplace_rel}: {name} is listed twice")
        listed[name] = entry

    dirs = mod_dirs(app)
    for mod in dirs:
        rel = f"mods/{app}/{mod.name}"
        if not NAME_RE.match(mod.name):
            problems.append(f"{rel}: folder name is not kebab-case")
        try:
            manifest = read_json(mod / spec["manifest"])
        except (OSError, json.JSONDecodeError) as err:
            problems.append(f"{rel}/{spec['manifest']}: {err}")
            manifest = {}
        if manifest and manifest.get("name") != mod.name:
            problems.append(f"{rel}: manifest name '{manifest.get('name')}' does not match the folder name")
        if manifest and not manifest.get("version"):
            problems.append(f"{rel}: manifest has no version")
        if not (mod / "README.md").is_file():
            problems.append(f"{rel}: README.md is missing")
        for path in mod.rglob("*"):
            if path.is_file() and ".claude-plugin/types" not in path.as_posix():
                try:
                    text = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                left = [p for p in PLACEHOLDERS if p in text or p in path.name]
                if left:
                    problems.append(f"{path.relative_to(ROOT)}: template placeholder {left[0]} left in")
        entry = listed.pop(mod.name, None)
        if entry is None:
            problems.append(f"{rel}: not listed in {marketplace_rel}")
        elif spec["source_of"](entry) != f"./{rel}":
            problems.append(f"{marketplace_rel}: {mod.name} source is {spec['source_of'](entry)!r}, expected './{rel}'")

    for name in listed:
        problems.append(f"{marketplace_rel}: {name} is listed but mods/{app}/{name}/ does not exist")

    return dirs


def run_claude(dirs, problems):
    claude = os.environ.get("CLAUDE_BIN", "claude")
    for mod in dirs:
        rel = mod.relative_to(ROOT)
        runs = [[claude, "plugin", "validate", str(mod)]]
        if any(mod.rglob("*.test.ts")) or any(mod.rglob("*.test.tsx")):
            runs.append([claude, "plugin", "test", str(mod)])
        for argv in runs:
            print(f"$ {' '.join(argv[1:3])} {rel}", flush=True)
            try:
                done = subprocess.run(argv, cwd=ROOT)
            except FileNotFoundError:
                problems.append(f"'{claude}' was not found; set CLAUDE_BIN or drop --run-claude")
                return
            if done.returncode != 0:
                problems.append(f"{rel}: claude {argv[2]} failed")


def cmd_check(args):
    problems = []
    found = {app: check_app(app, problems) for app in APPS}
    if args.run_claude:
        run_claude(found["claude-code"], problems)

    for app, dirs in found.items():
        print(f"{app}: {len(dirs)} mod(s){': ' if dirs else ''}{', '.join(d.name for d in dirs)}")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        sys.exit(1)
    print("ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="scaffold a mod from templates/<app>/ and list it in the app's marketplace")
    new.add_argument("app", choices=sorted(APPS))
    new.add_argument("name", help="kebab-case mod name, also the folder and manifest name")
    new.add_argument("-d", "--description", required=True, help="one line, no quotes")
    new.set_defaults(func=cmd_new)

    check = sub.add_parser("check", help="check every mod against its manifest and marketplace")
    check.add_argument("--run-claude", action="store_true", help="also run `claude plugin validate` and `claude plugin test` on each Claude Code mod")
    check.set_defaults(func=cmd_check)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
