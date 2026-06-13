# Project Setup

## Configuration

Use `vtb init` to configure a project:

```bash
vtb init [OPTIONS]
```

The command has no positional arguments or aliases. It registers the current
directory as a Sacrum project, writes the client configuration, and copies the
embedded command skills into the project. See
[Sacrum Config](../SACRUM_CONFIG.md) for the current config format and
environment overrides.

### Init Examples

```bash
# First-time setup when no token is already configured
vtb init --token <your-api-token>

# Use a non-default Sacrum API endpoint
vtb init --token <your-api-token> --url http://sacrum.example.com:4000

# Re-run safely after setup; existing config and project are reused
vtb init

# Copy embedded skills somewhere other than .claude/skills
vtb init --skills-target .custom/skills

# Machine-readable output
vtb init --json
```

### Init Options

| Flag | Description |
|------|-------------|
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `--url <URL>` | Sacrum API base URL; overrides the config file value and is saved when provided |
| `--token <TOKEN>` | Sacrum API token; overrides the config file value and is saved when provided |
| `--skills-target <SKILLS_TARGET>` | Target directory for embedded skills, relative to the current project unless an absolute path is provided (default: `.claude/skills`) |

`vtb init` derives the project slug from the current directory name, lowercases
it, and replaces spaces or special characters with hyphens. If no token is
provided and no token exists in the global config, the command fails before
contacting Sacrum and prints a hint to run `vtb init --token <your_token>`.
Sacrum API failures are reported as initialization errors while listing or
creating the project.

With `--json`, successful output is a JSON object containing `config_path`,
`project_slug`, `project_id`, `project_name`, `skills_copied`,
`skills_target`, and `project_created`. `skills_target` reports the resolved
directory used for the copy.

---

## CLI Help Validation

Use live help from the shipped `vtb` binary as the command syntax source of
truth when updating guide pages or installed command skills:

```bash
vtb --help
vtb <command> --help
```

---
