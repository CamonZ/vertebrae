---
name: init
description: Initialize vertebrae in a project
---

# /init

Initialize vertebrae in the current project. Registers the project with the Sacrum backend, writes global client config, and copies embedded skill files.

## Usage

```bash
vtb init [OPTIONS]

# First-time setup (requires API token)
vtb init --token <your-api-token>

# With custom Sacrum URL
vtb init --token <your-api-token> --url http://sacrum.example.com:4000

# Re-initialize (update skills, token already saved)
vtb init

# Custom skill target directory
vtb init --skills-target .custom/skills

# JSON output
vtb init --json
```

## Options

| Flag | Description |
|------|-------------|
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `--url <URL>` | Sacrum API base URL (overrides config file value and is saved when provided) |
| `--token <TOKEN>` | API token for Sacrum authentication (saved to config file) |
| `--skills-target <SKILLS_TARGET>` | Target directory for embedded skills (default: `.claude/skills`) |

There are no positional arguments, short flags, value enums, or aliases for this command.

## What It Does

1. Loads or bootstraps global config at `~/.config/vertebrae/config.toml`
2. Resolves API token (from `--token` flag or existing config)
3. Applies `--url` when provided
4. Derives project slug from current directory name
5. Checks if project exists in Sacrum, creates if needed
6. Registers project in global config
7. Copies embedded skill files to `--skills-target`

## Output

```
Vertebrae initialized successfully!

  Config file: /Users/you/.config/vertebrae/config.toml
  Project slug: my-project
  Project name: my-project
  Project ID: bb747fd8-5395-486f-bc8b-24ccd1615e18
  Created new Sacrum project
  Copied 32 skill(s) to /path/to/project/.claude/skills
```

With `--json`, successful output is a JSON object with `config_path`, `project_slug`, `project_id`, `project_name`, `skills_copied`, `skills_target`, and `project_created`. `skills_target` reports the resolved directory used for the copy.

If no token is passed and none exists in config, the command exits with a missing-token error and a hint to run `vtb init --token <your_token>`.

## Idempotent

Running `init` multiple times is safe:
- Existing config is preserved
- Skill files are updated/overwritten
- Project is reused if it already exists in Sacrum

## When to Use

- Setting up vertebrae in a new project
- After cloning a project that uses vertebrae
- Updating skill files after vertebrae updates
