# Architecture diagrams

The [C4 model](https://c4model.com) at three levels, each in two formats. The
source files are the diagrams — there are no checked-in images to go stale.

| Level | What it answers | PlantUML | Mermaid |
| --- | --- | --- | --- |
| **1 — Context** | Who uses it, and what it depends on | [`c4-1-context.puml`](c4-1-context.puml) | [`c4-1-context.mmd`](c4-1-context.mmd) |
| **2 — Container** | The runnable parts and the stores they share | [`c4-2-container.puml`](c4-2-container.puml) | [`c4-2-container.mmd`](c4-2-container.mmd) |
| **3 — Component** | The pipeline, one take end to end | [`c4-3-component-pipeline.puml`](c4-3-component-pipeline.puml) | [`c4-3-component-pipeline.mmd`](c4-3-component-pipeline.mmd) |
| **3 — Component** | Inside the render stage | [`c4-4-component-render.puml`](c4-4-component-render.puml) | [`c4-4-component-render.mmd`](c4-4-component-render.mmd) |

There is no level 4. C4's code level is a class diagram, and this is a
pipeline of functions with no object graph worth drawing — `README.md` explains
what each stage decides, and the source says it in more detail than a diagram
could.

## Two notes on what you will see

**Level 2 has one application container, and that is not a mistake.**
videoedit is a single Node process; the stages are components and they appear at
level 3. What earns the container diagram its place is not the code box but the
stores around it — the `in/`-to-`out/` pairing that is the whole bookkeeping, the
work directory that carries each run's metadata, the cache that costs money
rather than correctness, and `brand/`, which is the swappable part.

**Level 3 is split in two** because the render stage is where nearly all the
runtime goes and where every measured number about the look is spent. Mixing its
internals into the pipeline diagram would have buried both.

## Rendering them

**PlantUML** — the reference rendering. It wraps long descriptions, so these
files carry the reasoning as well as the boxes.

```
java -jar plantuml.jar -tpng -o out docs/*.puml
```

Or the JetBrains PlantUML plugin / VS Code PlantUML extension, which preview on
save. Both need Graphviz for layout. The diagrams pull the C4 macros over HTTPS
from `plantuml-stdlib/C4-PlantUML`; if you render offline, swap that `!include`
for the bundled-stdlib form noted in a comment at the top of each file.

**Mermaid** — renders in GitHub, GitLab and most IDEs, and needs no toolchain.

```
mmdc -i docs/c4-1-context.mmd -o context.png -w 1700 -b white
```

Or paste into [mermaid.live](https://mermaid.live). To show one in a Markdown
file, copy its body into a ```` ```mermaid ```` fence.

## Why the Mermaid versions are terser

Not carelessness, and not a different architecture — the same elements and the
same relationships, with the prose cut back.

Mermaid's C4 support is experimental and sizes each shape to fit its text
without wrapping. Give a box a sentence and it grows until only one fits per
row, and a nine-element diagram comes out as a single 2,600-pixel column with
its edge labels written across the boxes. Descriptions here are kept under about
45 characters, which is what it takes for the grid to hold at two per row.

So: read the `.puml` files for the reasoning, use the `.mmd` files where a
diagram has to render inside something else. If the two ever disagree about a
component or a dependency, the `.puml` is the one that was checked against the
code.

## Keeping them true

A diagram nobody maintains is worse than none, so the surface to watch is small
and specific:

- **A new or renamed module under `src/`** — add or rename its component in both
  level-3 files. Every component names its own file, which makes a stale one easy
  to spot.
- **A new stage in the pipeline** — it belongs in `c4-3-component-pipeline`
  with its number in the relationship label, matching the order `src/run.mjs`
  calls them in.
- **A new external dependency** (another TTS provider, a second binary) — level 1
  and level 2 both.
- **A new directory the pipeline reads or writes** — level 2, as a `ContainerDb`.
- **A new house rule** — the rules component's description at level 3, and
  `CLAUDE.md`, which is where the rules themselves live.

Renaming or re-describing a component is otherwise the whole job: the levels are
deliberately shallow, and nothing here tries to describe a function signature.
