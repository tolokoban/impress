# @tolokoban/impress

Convert markdown files into LibreOffice Impress presentations (`.odp`).

```sh
npx @tolokoban/impress course.md [other.md ...]
```

Each `foo.md` produces `foo.odp` in the same folder. Run it without arguments to see the help.

`@graph` diagrams are laid out by the [Graphviz](https://graphviz.org/) `dot` tool. When a file uses `@graph` and `dot` is not installed, `impress` offers to install it with the package manager of the system:

| System | Command |
| --- | --- |
| Linux | `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, `apk` or `brew` (with `sudo` when needed) |
| macOS | `brew install graphviz` or `sudo port install graphviz` |
| Windows | `winget install Graphviz.Graphviz`, `choco install graphviz` or `scoop install graphviz` |

Without a known package manager (or in a non-interactive shell), it prints how to install it instead, and the presentations using `@graph` fail.

Each time `dot` renders a diagram, the exact command is printed after a bold cyan `>`, so you can run it yourself to check the PNG:

```
  > /usr/bin/dot -Tpng -Gdpi=300 -Gbgcolor=transparent "-Gfontname=Liberation Sans" … diagram.dot
```

In a terminal, the output is colored: file names in bold, the example of AI prompt (printed when the files contain `@hint` pragmas) in cyan, and the questions waiting for an answer in bright yellow. Set the `NO_COLOR` environment variable (or redirect the output) to disable the colors.

## Slides

- `#` headings become section slides (blue background).
- Deeper headings become content slides, split over several slides when they are too long. A deeper heading with no content of its own, only sub-headings, gets a section slide too: its big title is still the `#` heading above it, and the deeper heading goes in the subtitle (e.g. `Possibilités`).
- Paragraphs, lists, tables, blockquotes and images are laid out automatically: images go beside or below the text depending on their shape.
- A table too long for one slide is first spread over two side-by-side tables on the same slide. If that is still too long, it is split over several slides. In both cases the header row is repeated on each part, and every part keeps the same column widths. Put `@compact` before the table to shrink it onto one slide instead (see [Pragmas](#pragmas)).
- Table cells can hold images, as HTML (`<img src="logos/claude.webp" alt="Claude" width="48" height="48">`) or markdown (`![Claude](logos/claude.webp)`). Their pixel sizes assume a 16px font: a 48px image is 3 times as tall as the text of the table, and it shrinks with the text of a `@compact` table. With only `width` or `height`, the other one follows the shape of the image; with neither, the image is 2 lines tall. An image alone in its cell is centered, otherwise it comes before the text. Images too wide for their column are shrunk to fit.
- Every image embedded in the `.odp` (PNG, JPEG, SVG, `@graph` diagrams, background images) is converted to WebP, at quality 70 by default (see [`theme.images`](#themeimages)). The `.odp` stays light, and SVG files look in the slides as they do in a browser, since they are rasterized before LibreOffice sees them.
- Lists can be bulleted (`- item`, `* item`) or numbered (`1. item`, `1) item`), and the two can be nested in each other. A numbered list starts at the number of its first item (`4.` starts at 4); the number of each following item is computed, not read. Numbered items get numbers `1.`, then letters `a.` and roman numerals `i.` when nested (see [Numbers](#numbers)).
- Blockquotes (`> ...`) are shown in a bordered box with a soft blurred shadow.
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
| `@layout …` *(not followed by a heading)* | Put the next blocks of the section (paragraph, list, image, table…) on one slide, one block per cell, without cell headings. |
| `@graph <file.dot>` | Insert a Graphviz diagram (path relative to the `.md`), rendered by `dot -Tpng` (the same Cairo renderer as DOT viewers, so the diagram looks the same in the slides) and embedded in the `.odp` as a WebP image. The fonts, sizes and colors of the theme are inserted as `graph [...]`, `node [...]` and `edge [...]` defaults at the start of the graph, so every attribute set in the `.dot` file wins, including its own `node [...]` / `edge [...]` defaults. |
| `@next` | Start a new slide with the same title as the current one. If the next line is a heading (`#`, `##`…), that heading gives the new slide its title instead. |
| `@compact` | The next table of the section, if it is too long for one slide, has its text shrunk (down to 4pt) until it fits on one slide with the paragraph introducing it, instead of being split into two columns or over several slides. The words of the header are never cut: if one of them is too long for its column, the text is shrunk further, even when the table would fit at full size (a header cell of several words may still wrap between words). |
| `@reveal [C<columns>] [R<rows>]` | The rows of the next table appear one slide after the other: the first slide shows only the header, each following slide reveals one more row. The table keeps its final size and place from the first slide. `C` and `R` list the columns and the body rows (counted from 1, header excluded) that are always visible, as numbers and ranges: `@reveal C1,3 R1-4` always shows columns 1 and 3 and rows 1 to 4. Both are optional. The speaker notes are repeated on every slide of the sequence. A revealed table always stays on one slide, and its header words are never cut, as with `@compact`: if it is too long, its rows are first spread over two side-by-side tables, and if that is still too long, its text is shrunk, on one table or two side by side, whichever keeps the text bigger. A table inside an `@layout` is shown entirely. |

When some files contain `@hint`, the end of the output gives a ready-to-paste prompt asking an AI agent to apply them to the `.odp`.

## Styles

Every element of the slides uses a named style, so it can also be changed afterwards in LibreOffice (Styles sidebar: _Drawing Styles_ and _Presentation Styles_).

The first conversion of `foo.md` writes `foo.style.json` with the complete default style. Edit it and run again to restyle the presentation. The file is never overwritten: delete it to get the defaults back (for instance after upgrading `@tolokoban/impress`).

### Merging with the defaults

`foo.style.json` is merged over the built-in defaults:

- objects are merged key by key, so the file can contain only the values you want to change;
- arrays and plain values replace the default ones entirely (e.g. `theme.colors.grid`, `bullets.chars`);
- default styles cannot be removed, only overridden. Unknown keys are kept, which is how you add new styles, markers or dashes.

```json
{ "theme": { "colors": { "primary": "#800020" } } }
```

The file has six top-level sections:

| Key | Content |
| --- | --- |
| `theme` | Colors, fonts, font sizes, slide geometry and diagram options. |
| `styles` | Every named style, with ODF properties. |
| `tableTemplates` | Which cell styles a table uses for its header, body and banded rows. |
| `spanStyles` | Inline formatting: bold, italic, code. |
| `markers` | Line ends (arrows) used by diagram edges. |
| `dashes` | Dash patterns used by diagram edges and shapes. |

### Theme

The theme gathers the values that are used in several places. Changing it is the easiest way to restyle a whole presentation.

#### `theme.colors`

| Key | Default | Used by |
| --- | --- | --- |
| `primary` | `#1F3A5F` | Slide titles, section background, table headers, quote text and border, diagram node borders. |
| `accent` | `#E8833A` | Left bar of content slides, line under section titles, bullets. |
| `ink` | `#222222` | Body text, code, diagram edges. |
| `muted` | `#7A8899` | Breadcrumb, prompt shadow, diagram clusters. |
| `subtitle` | `#FFD8B0` | Breadcrumb shown under the title of a section slide. |
| `white` | `#FFFFFF` | Section titles, table header text, table cells. |
| `quoteBackground` | `#F1F4F8` | Blockquotes. |
| `promptBackground` | `#DCEBFF` | ` ```prompt ` chat bubbles. |
| `promptInk` | `#0B2545` | Text of chat bubbles. |
| `codeBackground` | `#F3F3F3` | Other code blocks. |
| `tableBorder` | `#C9D3DF` | Table cell borders. |
| `tableBand` | `#EEF2F7` | Every other table row. |
| `gridBackground` | `#F7F7F7` | Body of the cells of `@layout grid`. |
| `graphNode` | `#EAF1FB` | `@graph` node background. |
| `graphCluster` | `#F5F7FA` | `@graph` cluster (subgraph) background. |
| `grid` | 4 pairs | `[background, text]` of each `@layout grid` cell heading, used in turn (cell 5 reuses the colors of cell 1). |

You can add your own colors to the theme and reference them in styles, e.g. `"draw:fill-color": "{colors.myGreen}"`.

To change the number of colors in `grid`, also add (or keep) the matching styles: the cell `n` of a grid uses `Grille-titre-n` and `Grille-texte-n`, and the defaults only define 1 to 4. For a fifth color:

```json
{
    "theme": { "colors": { "grid": [["#C0392B", "#FFFFFF"], ["#E67E22", "#FFFFFF"], ["#F1C40F", "#222222"], ["#27AE60", "#FFFFFF"], ["#8E44AD", "#FFFFFF"]] } },
    "styles": {
        "Grille-titre-5": { "family": "graphic", "parent": "Grille-titre", "graphic": { "draw:fill-color": "{colors.grid.4.0}" }, "text": { "fo:color": "{colors.grid.4.1}" } },
        "Grille-texte-5": { "family": "graphic", "parent": "Grille-texte", "graphic": { "svg:stroke-color": "{colors.grid.4.0}" } }
    }
}
```

#### `theme.fonts`

| Key | Default | Used by |
| --- | --- | --- |
| `sans` | `'Liberation Sans'` | All the text, and the Graphviz layout of `@graph` diagrams. |
| `mono` | `'DejaVu Sans Mono'` | Code blocks and inline `` `code` ``. |

Use the font name as LibreOffice knows it, with quotes when it contains spaces. The font must be installed on the computer that opens the `.odp`.

#### `theme.sizes`

Font sizes, in points. They are not only applied to the text: they are also used to **estimate the height of the text** when laying out slides and deciding where to split a section over several slides. So prefer changing a size here rather than `fo:font-size` in a style, otherwise the layout will not match the text.

| Key | Default | Used by |
| --- | --- | --- |
| `title` | 34 | Title of content slides. |
| `sectionTitle` | 44 | Title of section slides (`#` headings). |
| `subtitle` | 20 | Breadcrumb under a section title. |
| `breadcrumb` | 14 | Breadcrumb above the title of content slides. |
| `text` | 24 | Paragraphs. |
| `list` | `[24, 21, 18, …]` | List items, one size per level (9 levels). |
| `quote` | 24 | Blockquotes. |
| `prompt` | 20 | Chat bubbles. |
| `code` | 14 | Code blocks. |
| `table` | 18 | Tables on a content slide. |
| `tableSmall` | 11 | Tables inside a `@layout` cell or column. |
| `columnTitle`, `columnText` | 16, 16 | Headings and content of `@layout columns`. |
| `gridTitle`, `gridText` | 16, 12 | Headings and content of `@layout grid`. |
| `notes` | 14 | Speaker notes. |
| `graphText` | 14 | `@graph` node labels (unless the `.dot` sets `fontsize`). |
| `graphEdgeText` | 12 | `@graph` edge, cluster and graph labels. |

Text boxes shrink their text when it does not fit (`style:shrink-to-fit`), so a too optimistic estimate only makes the text smaller.

#### `theme.slide` and `theme.content`

Geometry, in centimeters.

- `slide`: `width` and `height` of the slides (default 28 × 15.75, i.e. 16:9). For 4:3, use for instance 28 × 21 and adapt `content`.
- `content`: the area that receives the content of the slides, below the title: `x`, `y`, `width`, `height`, and the vertical `gap` between two blocks. `align` places the content vertically in this area: `"top"` (default) or `"center"`. With `"center"`, a slide holding only a few bullets has them in the middle of the slide instead of at the top (a wide image under the text still fills the remaining height).

The title, the breadcrumb and the decorations of the master pages have fixed positions (title at 0.95 cm from the top, line at 2.7 cm), section slides assume a slide about 28 cm wide, and the slide background is always white (change it in LibreOffice with _Slide › Slide Properties › Background_ on each master slide).

#### `theme.graph`

Options for `@graph` diagrams.

- `maxScale`: maximum enlargement of a diagram relative to its Graphviz size (default 1.5). Small diagrams are not blown up, so their text does not become huge.
- `dpi`: resolution of the PNG rendered by Graphviz (default 300). Do not set `dpi` in the `.dot` file: the size of the diagram on the slide is computed from this one.

#### `theme.images`

Every embedded image is stored as WebP.

- `quality`: WebP quality, from 0 to 100 (default 70).
- `maxSize`: longest side in pixels (default 3840): larger images are shrunk. SVG images are rasterized at this size.

A WebP image already within `maxSize` is embedded as is, so it does not lose quality twice.

#### `theme.backgrounds`

An image for each master page (`Master` for content slides, `Section` for section slides), drawn above the background color and below the decorations and the text.

- `image`: path relative to the markdown file, `""` (default) for no image.
- `fit`: `"stretch"` (default) fills the area, `"contain"` keeps the aspect ratio and centers the image in the area.
- `x`, `y`, `width`, `height`: the area in centimeters (default: the whole slide).

The look of the image comes from the `Master-image` and `Section-image` styles: `draw:image-opacity`, `draw:color-mode` (`standard`, `greyscale`, `mono` or `watermark`), `draw:luminance`, `draw:contrast`, `draw:gamma`, `draw:red`, `draw:green`, `draw:blue`...

```json
{
    "theme": { "backgrounds": { "Section": { "image": "images/city.jpg" } } },
    "styles": { "Section-image": { "graphic": { "draw:image-opacity": "25%", "draw:color-mode": "greyscale" } } }
}
```

LibreOffice ignores image adjustments inherited from a named style, so they are also written to an automatic style on each image: change them in `foo.style.json` rather than in LibreOffice's Styles sidebar.

### Placeholders

Any string value of `styles`, `spanStyles`, `markers`, `dashes`, `bullets` or `numbers` can reference the theme with `{path}`, where `path` is a dot-separated path in `theme` (array indexes are numbers):

```json
"fo:color": "{colors.primary}"
"fo:font-size": "{sizes.title}pt"
"fo:font-size": "{sizes.list.2}pt"
"draw:fill-color": "{colors.grid.0.0}"
"fo:border": "0.03cm solid {colors.tableBorder}"
```

A placeholder can be part of a longer value. An unknown path stops the conversion with an error naming the faulty style.

### Named styles

Each entry of `styles` is one named style:

```json
"Citation": {
    "family": "graphic",
    "parent": "standard",
    "graphic": { "draw:fill-color": "{colors.quoteBackground}" },
    "paragraph": { "fo:line-height": "115%" },
    "text": { "fo:font-style": "italic", "fo:color": "{colors.primary}" }
}
```

| Key | Meaning |
| --- | --- |
| `family` | `graphic` (drawing style), `presentation` (master page placeholders) or `table-cell`. Do not change it for an existing style. |
| `parent` | Style to inherit from: only the differences need to be given. |
| `graphic` | Properties of the shape: fill, border, shadow, padding, text alignment in the box… |
| `paragraph` | Properties of the paragraphs: alignment, margins, line height… |
| `text` | Properties of the characters: font, size, weight, style, color… |
| `bullets` | Bullets of lists (only for styles that hold lists, see below). |
| `numbers` | Numbers of numbered lists (only for styles that hold lists, see below). |

Since styles inherit from each other, changing a parent changes all its children. For instance every drawing style derives from `standard`, and `Code` derives from `Prompt`.

#### Where each style is used

**Content slides** (master page `Master`):

| Style | Element |
| --- | --- |
| `Master-title` | Slide title. |
| `Fil-ariane` | Breadcrumb (parent headings) above the title. |
| `Master-outline1` … `Master-outline9` | Lists, one style per level (each level inherits from the previous one). |
| `Texte` | Paragraphs. |
| `Citation` | Blockquotes. |
| `Prompt` | ` ```prompt ` code blocks (chat bubbles). |
| `Code` | Other code blocks. |
| `Image` | Frame of images. |
| `Tableau-cadre` | Frame around tables. |
| `Decor` | Vertical bar on the left of the slide. |
| `Master-image` | Background image (`theme.backgrounds.Master`). |
| `Decor-ligne` | Line under the title. |
| `Master-notes` | Speaker notes. |

**Section slides** (master page `Section`, for `#` headings):

| Style | Element |
| --- | --- |
| `Section-title` | Title: always the `#` heading. |
| `Section-subtitle` | Breadcrumb of the deeper headings, under the title. |
| `Section-fond` | Full-slide background rectangle. |
| `Section-image` | Background image (`theme.backgrounds.Section`), above `Section-fond`. |
| `Decor` | Horizontal bar under the title. |
| `Section-notes` | Speaker notes. |

`Section-outline1…9`, `Master-subtitle`, `*-background` and `*-backgroundobjects` exist for LibreOffice's master pages but are not used by the generated content.

**Tables:**

| Style | Element |
| --- | --- |
| `Tableau-entete` | Header row. |
| `Tableau-cellule` | Body cells. |
| `Tableau-cellule-alt` | Every other body row. |
| `Tableau-petit-entete`, `Tableau-petit-cellule`, `Tableau-petit-cellule-alt` | Same, for tables inside a `@layout` cell or column. |

Cell borders are a `paragraph` property (`fo:border`) and padding a `graphic` property (`fo:padding-*`).

**`@layout columns`:** `Colonne-titre` (heading of each column) and `Colonne-texte` (its content, with bullets).

**`@layout grid`:** `Grille-titre` and `Grille-texte` hold the common properties; `Grille-titre-1…4` and `Grille-texte-1…4` only add the colors of each cell, taken from `theme.colors.grid`.


#### Common properties

Property names are the ODF attribute names, as LibreOffice writes them in its own files. Lengths need a unit (`cm`, `mm`, `in`, `pt`), colors are `#RRGGBB`. The most useful ones:

| Group | Property | Example values |
| --- | --- | --- |
| `text` | `fo:font-family` | `"{fonts.sans}"`, `"'Open Sans'"` |
| `text` | `fo:font-size` | `"{sizes.text}pt"`, `"18pt"` |
| `text` | `fo:font-weight` | `bold`, `normal` |
| `text` | `fo:font-style` | `italic`, `normal` |
| `text` | `fo:color` | `"#222222"` |
| `text` | `style:text-underline-style` | `solid`, `none` |
| `text` | `fo:text-transform` | `uppercase`, `none` |
| `text` | `fo:letter-spacing` | `0.05cm`, `normal` |
| `text` | `fo:text-shadow` | `1pt 1pt`, `none` |
| `paragraph` | `fo:text-align` | `start`, `center`, `end`, `justify` |
| `paragraph` | `fo:line-height` | `110%`, `0.8cm` |
| `paragraph` | `fo:margin-top`, `fo:margin-bottom` | `0.2cm` |
| `paragraph` | `fo:margin-left`, `fo:text-indent` | `0.5cm`, `-0.5cm` |
| `paragraph` | `fo:border` | `0.03cm solid #C9D3DF` (table cells) |
| `graphic` | `draw:fill` | `none`, `solid`, `gradient`, `hatch` |
| `graphic` | `draw:fill-color` | `"{colors.primary}"` |
| `graphic` | `draw:opacity` | `80%` |
| `graphic` | `draw:stroke` | `none`, `solid`, `dash` |
| `graphic` | `svg:stroke-color`, `svg:stroke-width` | `"#1F3A5F"`, `0.03cm` |
| `graphic` | `draw:stroke-dash` | name of an entry of `dashes`, e.g. `Tirets` (with `draw:stroke` = `dash`) |
| `graphic` | `draw:marker-start`, `draw:marker-end` | name of an entry of `markers`, e.g. `Fleche` |
| `graphic` | `draw:marker-start-width`, `draw:marker-end-width` | `0.3cm` |
| `graphic` | `draw:shadow` | `visible`, `hidden` |
| `graphic` | `draw:shadow-offset-x`, `draw:shadow-offset-y` | `0.08cm` |
| `graphic` | `draw:shadow-color`, `draw:shadow-opacity` | `"{colors.muted}"`, `35%` |
| `graphic` | `fo:padding-left`, `-right`, `-top`, `-bottom` | `0.3cm` |
| `graphic` | `draw:textarea-vertical-align` | `top`, `middle`, `bottom` |
| `graphic` | `draw:textarea-horizontal-align` | `left`, `center`, `right`, `justify` |
| `graphic` | `style:shrink-to-fit` | `true`: shrink the text that does not fit in its box |

Any other ODF property is written as is. If LibreOffice does not know it, it is ignored silently: when in doubt, set the property in LibreOffice, save as `.fodp` (flat XML) and look at the attribute it writes.

Two properties are on purpose on most text styles and are best kept: `style:shrink-to-fit` (`true`) and `draw:auto-grow-height` (`false`). Without them, a text that is longer than estimated overflows its box instead of being shrunk.

#### Bullets

Styles that hold lists (`Master-outline1`, `Colonne-texte`, `Grille-texte`) have a `bullets` entry:

```json
"bullets": {
    "chars": ["●", "–", "●", "–", "●", "–", "●", "–", "●"],
    "color": "{colors.accent}",
    "indent": 0.9,
    "size": "80%"
}
```

- `chars`: bullet character of each level, from 1 to 9 (drawn with the _OpenSymbol_ font, so `■`, `▸`, `✓`, `→`… work too).
- `color`: color of the bullets.
- `indent`: indentation added at each level, in cm (a number, not a string).
- `size`: size of the bullet relative to the text.

Nested list items use the level of `chars` matching their depth: `Master-outline2…9` do not need a `bullets` entry of their own.

#### Numbers

The same styles have a `numbers` entry, used by numbered lists (`1. item`):

```json
"numbers": {
    "formats": ["1", "a", "i", "1", "a", "i", "1", "a", "i"],
    "suffix": ".",
    "color": "{colors.accent}",
    "size": "100%",
    "weight": "bold",
    "indent": 0.9,
    "width": 0.9
}
```

- `formats`: numbering of each level, from 1 to 9: `"1"` (1, 2, 3…), `"a"` / `"A"` (letters), `"i"` / `"I"` (roman numerals).
- `suffix`: text after the number. It applies to every item, so `1)` in the markdown is shown as `1.` with the default suffix.
- `color`, `size`, `weight` (`"bold"` or `"normal"`): look of the numbers.
- `indent`: indentation added at each level, in cm.
- `width`: room left for the number before the text, in cm.

A list holding numbered items is written with two named list styles, `<style>-numbers` and `<style>-bullets` (e.g. `Master-outline1-numbers`), built from `numbers` and `bullets`, so bullets nested in a numbered list (and the reverse) keep their own look. Lists with bullets only keep using the bullets of the frame style. Styles that only inherit lists (`Grille-texte-1…4`) use the entries of their parent.

### Table templates

`tableTemplates` tells LibreOffice which cell style each part of a table uses. There are two templates, `Tableau` and `Tableau-petit`:

```json
{ "name": "Tableau", "header": "Tableau-entete", "body": "Tableau-cellule", "bandedRows": "Tableau-cellule-alt" }
```

To remove the banding, point `bandedRows` to the same style as `body` (or give both styles the same fill color).

### Inline formatting

Impress has no character styles, so inline formatting is defined in `spanStyles`, with `text` properties only:

| Style | Markdown |
| --- | --- |
| `T_b` | `**bold**` |
| `T_i` | `*italic*` |
| `T_bi` | `***bold italic***` |
| `T_code` | `` `code` `` |

For instance, to show inline code in color on a light background:

```json
{ "spanStyles": { "T_code": { "fo:font-family": "{fonts.mono}", "fo:color": "{colors.accent}", "fo:background-color": "#F3F3F3" } } }
```

Like everything else, span styles are merged with the defaults: here `T_code` keeps its font family even if it is omitted.

### Markers and dashes

`markers` defines line ends, referenced by name in `draw:marker-start` / `draw:marker-end`. Each one is an SVG path with its `viewBox`; the tip of the arrow points to the top of the view box:

```json
"markers": {
    "Fleche": { "viewBox": "0 0 20 30", "d": "M10 0l-10 30h20z" },
    "Rond": { "viewBox": "0 0 20 20", "d": "M10 0a10 10 0 1 0 0.01 0z" }
}
```

`dashes` defines dash patterns, referenced by name in `draw:stroke-dash`, with the ODF attributes of `<draw:stroke-dash>`: `draw:style` (`rect` or `round`), `draw:dots1`, `draw:dots1-length`, `draw:dots2`, `draw:dots2-length` and `draw:distance`.

The **first** entry of `dashes` (`Tirets` by default) is used for `@graph` nodes and edges with `style=dashed` or `style=dotted`.

### Recipes

Bigger text everywhere:

```json
{ "theme": { "sizes": { "text": 28, "list": [28, 24, 20, 20, 20, 20, 20, 20, 20], "title": 38 } } }
```

Centered slide titles without the line:

```json
{
    "styles": {
        "Master-title": { "paragraph": { "fo:text-align": "center" } },
        "Decor-ligne": { "graphic": { "draw:stroke": "none" } }
    }
}
```

Chat bubbles without shadow:

```json
{ "styles": { "Prompt": { "graphic": { "draw:shadow": "hidden" } } } }
```

## Development

```sh
npm install
npm run build   # transpile src/*.ts into dist/
npm run pub     # build and publish to npmjs
```

Requires Node.js 20.15 or later. Images are converted with [sharp](https://sharp.pixelplumbing.com/), installed by npm with prebuilt binaries.
