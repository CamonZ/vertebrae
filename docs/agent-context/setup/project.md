# Project

Purpose: connect a repository to a Vertebrae project.
Use this when: `vtb` cannot find a project, or setting up a new repository.

## How it works
- `vtb` resolves the active project from the current working directory: the
  `[projects.<name>]` entry in [config](config.md) whose path is the longest
  prefix of the directory wins. Run it inside the project checkout.
- `vtb init` initializes Vertebrae in the current project (see `vtb init --help`);
  it also installs the Vertebrae skills.

## Doing it
`cd <repo> && vtb list` to confirm the project resolves.
Pass absolute paths for files outside the repo (e.g. `--questions @/tmp/q.json`)
instead of running `vtb` from elsewhere.

## Gotchas
Running `vtb` from `/tmp` or another repo fails with "No vertebrae project found"
or acts on a different project.

## Related
[Config](config.md) · [Daemon](daemon.md)
