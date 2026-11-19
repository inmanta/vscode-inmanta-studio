# Inmanta Studio

Visual editors for Inmanta projects. Installing Inmanta Studio also installs the [Inmanta extension](https://marketplace.visualstudio.com/items?itemName=Inmanta.inmanta) for the language support. The studios themselves don't need the language server or the Python extension.

## Installation

Inmanta Studio is not on the VS Code marketplace. Download `inmanta-studio-<version>.vsix` from the artifacts of the latest CI build of `master`, then run *Extensions: Install from VSIX...* in VS Code, or `code --install-extension inmanta-studio-<version>.vsix`. This also installs the Inmanta extension from the marketplace.

## Lifecycle Studio
Open a csv lifecycle of `future::lsm::fsm` (a `lifecycle.csv` with `name`, `desired_state` and `on_*` columns) with the **Open in Lifecycle Studio** button in the editor title, or with *Open With... > Inmanta Lifecycle Studio*. The studio has three modes:

- **View**: the lifecycle as a graph, grouped in stages (the `web_stage` annotation, or the desired state). The detail level goes from coarse to fine: **Desired states** (one box per desired state), **States** (the rows of the csv) and **States + validation** (every state in the orchestrator, including the `validating_*` and `rejected_*` states the factory generates).
- **Edit**: change states and transfers in the inspector, or drag the handle of the selected state onto another state to add a transfer. Every edit is a normal edit of the csv, so undo, save and diff work as usual.
  The sidebar lists the states, the stages and the desired states. Selecting a desired state edits its row of `states.csv`: its options, `created_child`, `removed_child` and the annotation defaults. Renaming it updates `desired_state` in the lifecycle csv.
  The stages tab adds, names, orders and deletes stages. Drop a state on a stage to set its `web_stage`, drag a stage by its title to arrange the canvas. Once declared, the stages are laid out left to right in their order.
- **Simulate**: create an instance or start in any state, then send updates, deletes, set state calls, validation results and resource outcomes. The studio shows the attribute sets, the desired state and the `states.csv` options the model sees in each kind of compile, and saves runs as scenarios.
- **Table**: the lifecycle csv, the states csv and the transfers csv as tables with a column type each. A cell suggests its values (states, `validate(...)` expressions, desired states, labels, icons) and is checked while typing. Arrow keys move, Enter or typing edits, copy and paste work with spreadsheets, Ctrl+D fills down and Delete clears the selected cells.

For every state, the inspector previews what the web console shows: the state badge (`web_label`, `web_icon`, `web_description`) and the Actions menu with the set state buttons and their transfer annotations (`web_button_label`, `web_confirm`, `web_advanced_state`, ...). In Simulate mode these buttons drive the simulation.

The `states.csv` next to the lifecycle csv is picked up automatically. What the lifecycle csv can't hold goes in files next to it, which can also be written by hand: the transfer annotations in `<name>.transfers.csv` (one row per transfer, identified by `source`, `trigger` and `target`, pass it as the `transfers_csv_file` of `future::lsm::fsm::LifecycleFactory`), the stages in display order in `<name>.stages.csv`, and the layout and scenarios, which only the studio uses, in `<name>.studio.yml`. The lifecycle checks are also reported in the Problems panel for any open lifecycle csv. The studio works without the language server.

## Onboarding Studio
Open the `onboard.yaml` of an onboarding workspace with the **Open in Onboarding Studio** button in the editor title, or with *Open With... > Inmanta Onboarding Studio*. The studio runs `onboard serve`, the engine that keeps the workspace up to date and pushes what changed:

- **Pipeline**: the status of the workspace, the steps the engine runs by itself (fetch, observe, identify, ...) with when they last ran, the sources and the observation types with their counts.
- **Candidates**: the candidates by stage, with their findings, attributes, instance and classified changes. Check several candidates for the bulk commands.
- **Rules**: the files of the pack, to open in the editor.
- **Activity**: every command that ran, with its output.

Every action is one `onboard` command as the CLI takes it, so nothing happens that you could not type yourself. A suggestion is only applied when you run `review set`. `review edit` and `rules diff` open their draft in an editor tab: save it to apply, close it without saving to abort. When the engine refuses a draft, the reason is written on top of it: fix it and save again. The engine is the first `.venv` up from the workspace, or the python of `inmanta.onboarding.python`.

## Development

```sh
npm install
npm run lint
npm run test:unit
npm run compile        # or: npm run watch
npx vsce package
```
