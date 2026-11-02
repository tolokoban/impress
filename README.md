# @tolokoban/impress

Convert markdown files into LibreOffice Impress presentations (`.odp`).

```sh
npx @tolokoban/impress course.md [other.md ...]
```

Each `foo.md` produces `foo.odp` in the same folder. Run it without arguments to see the help.

## Slides

- `#` headings become section slides (blue background).
- Deeper headings become content slides, split over several slides when they are too long.
- Paragraphs, lists, tables, blockquotes and images are laid out automatically: images go beside or below the text depending on their shape.
- A code block whose language is `prompt` is shown as a chat bubble.

## Pragmas

At the start of a line in the `.md` file:

| Pragma | Effect |
| --- | --- |
| `@note <text>` | Speaker note of the current slide (seen by the teacher only). |
| `@note begin` … `@note end` | Multi-line speaker note. |
| `@hint <text>` | Instruction for an AI: stored verbatim in the `.odp` (alt-text of the slide title), never displayed. |
| `@layout grid <C>x<R>` | Put the next C×R sections (starting at the next heading) on one slide, in a grid. |
| `@layout columns <sizes>` | Put the next sections on one slide, in columns sized `1fr`, `2fr`… or `auto` (one size per section). |
| `@graph <file.dot>` | Insert a Graphviz diagram (path relative to the `.md`) as native shapes, editable in Impress without the `.dot` file. |

When some files contain `@hint`, the end of the output gives a ready-to-paste prompt asking an AI agent to apply them to the `.odp`.

## Styles

Every element of the slides uses a named style, so it can be changed in LibreOffice (Styles sidebar).

The first conversion of `foo.md` also writes `foo.style.json` with the default styles. Edit it and run again to restyle the presentation:

- `theme`: colors, fonts, font sizes and slide geometry. Style values can reference it, e.g. `"{colors.primary}"` or `"{sizes.title}pt"`.
- `styles`: every named style, with ODF properties (`fo:font-size`, `draw:fill-color`…).

The file is merged over the defaults, so it can also contain only the values you want to change:

```json
{ "theme": { "colors": { "primary": "#800020" } } }
```

## Development

```sh
npm install
npm run build   # transpile src/*.ts into dist/
npm run pub     # build and publish to npmjs
```

Requires Node.js 20.15 or later. Graphviz is bundled as WebAssembly (`@hpcc-js/wasm-graphviz`): nothing else to install.
