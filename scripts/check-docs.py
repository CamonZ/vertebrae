#!/usr/bin/env python3
"""Bounded offline checks for maintained documentation links and skill files."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / "CLAUDE.md", ROOT / "README.md", ROOT / "docs"]
LINK = re.compile(r"\[[^]]+\]\(([^)]+)\)")

def files():
    out = []
    for item in SOURCES:
        if item.is_file(): out.append(item)
        elif item.is_dir(): out.extend(item.rglob("*.md"))
    out.extend(ROOT.glob("skills/*/SKILL.md"))
    out.extend(ROOT.glob(".claude/skills/*/SKILL.md"))
    return sorted(set(out))

def main():
    errors = []
    for source in files():
        for match in LINK.finditer(source.read_text(encoding="utf-8")):
            target = match.group(1).split("#", 1)[0]
            if not target or re.match(r"(?:https?|mailto|vtb)://", target):
                continue
            path = (source.parent / target).resolve()
            if not path.exists():
                errors.append(f"{source.relative_to(ROOT)}: missing link target {target}")
    for skill in ROOT.glob("skills/*/SKILL.md"):
        if not skill.is_file(): errors.append(f"missing active skill: {skill}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"checked {len(files())} maintained Markdown sources; local links resolve")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
