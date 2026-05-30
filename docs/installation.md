# Installation

The `./run/install` script copies extensions from this repository's `ext/` directory into Pi's extensions directory in your home directory, where Pi auto-discovers them.

## Running the installer

Make the script executable (once), then run it from anywhere:

```sh
chmod +x run/install
./run/install
```

With no arguments, every available extension is installed.

### Options

| Invocation              | Effect                                |
| ----------------------- | ------------------------------------- |
| `./run/install`         | Install all available extensions.     |
| `./run/install <name>…` | Install one or more named extensions. |
| `./run/install -l`      | List available extensions and exit.   |
| `./run/install --list`  | Same as `-l`.                         |
| `./run/install -h`      | Show usage help and exit.             |
| `./run/install --help`  | Same as `-h`.                         |

### Examples

```sh
./run/install                        # Install all.
./run/install pickling-gnomes        # Install one.
./run/install pickling-gnomes other  # Install multiple.
./run/install --list                 # See what is available.
```

Unknown extension names are reported and skipped; the rest of the run continues.

## What the installer does

For each extension it:

1. Ensures Pi's extensions directory exists, creating `~/.pi/agent/extensions/` if necessary.
2. Backs up any existing install of the same name to `~/.pi/agent/extensions/<name>.backup.<timestamp>/` before overwriting.
3. Copies the extension's source directory (`ext/<name>/`, entry point `index.ts`) to `~/.pi/agent/extensions/<name>/`, preserving the directory layout so multi-file extensions work.

## After installing

1. Start or restart Pi:

   ```sh
   pi
   ```

2. In Pi, reload extensions to pick up the new files:

   ```text
   /reload
   ```

Auto-discovered extensions in `~/.pi/agent/extensions/` can be hot-reloaded with `/reload`; there is no need to restart Pi after the first launch.

## Adding a new extension

Each extension lives in its own directory under `ext/`, with an `index.ts` entry point:

```text
ext/
└── <name>/
    └── index.ts
```

For the installer to offer it, add the directory name to the `available_extensions` array in [`run/install`](../run/install), and give it a description in `list_available_extensions` ([`run/inc/fn/extensions.sh`](../run/inc/fn/extensions.sh)).
