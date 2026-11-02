/**
 * Default Impress styles used by `impress.ts`.
 *
 * Every visible element of the generated slides references one of the
 * styles defined here, so they can also be tweaked afterwards in
 * LibreOffice (Styles sidebar: "Drawing Styles" and "Presentation Styles").
 *
 * For each `foo.md`, `impress.ts` writes these defaults to `foo.style.json`
 * if it does not exist yet; otherwise that file is merged over the defaults.
 *
 * Property keys are ODF attribute names (`fo:font-size`, `draw:fill-color`, ...).
 * Values can reference the theme with placeholders: "{colors.primary}",
 * "{sizes.title}pt", "{colors.grid.0.1}"...
 */

export type Props = Record<string, string>

export interface StyleDef {
    family: "graphic" | "presentation" | "table-cell"
    parent?: string
    graphic?: Props
    paragraph?: Props
    text?: Props
    /** Bullets for list levels 1 to 9 (only for styles holding lists). */
    bullets?: BulletDef
}

export interface BulletDef {
    chars: string[]
    color: string
    /** Indentation added for each level, in cm. */
    indent: number
    /** Size of the bullet relative to the text. */
    size: string
}

export interface TableTemplate {
    name: string
    header: string
    body: string
    bandedRows: string
}

export const defaultTheme = {
    colors: {
        primary: "#1F3A5F",
        accent: "#E8833A",
        ink: "#222222",
        muted: "#7A8899",
        subtitle: "#FFD8B0",
        white: "#FFFFFF",
        quoteBackground: "#F1F4F8",
        promptBackground: "#DCEBFF",
        promptInk: "#0B2545",
        codeBackground: "#F3F3F3",
        tableBorder: "#C9D3DF",
        tableBand: "#EEF2F7",
        gridBackground: "#F7F7F7",
        graphNode: "#EAF1FB",
        graphCluster: "#F5F7FA",
        /** One color per cell of a 2×2 grid: [background, text]. */
        grid: [
            ["#C0392B", "#FFFFFF"],
            ["#E67E22", "#FFFFFF"],
            ["#F1C40F", "#222222"],
            ["#27AE60", "#FFFFFF"],
        ],
    },
    fonts: {
        sans: "'Liberation Sans'",
        mono: "'DejaVu Sans Mono'",
    },
    /** Font sizes in points. They are also used to estimate text heights. */
    sizes: {
        title: 34,
        sectionTitle: 44,
        subtitle: 20,
        breadcrumb: 14,
        text: 24,
        list: [24, 21, 18, 18, 18, 18, 18, 18, 18],
        quote: 24,
        prompt: 20,
        code: 14,
        table: 18,
        tableSmall: 11,
        columnTitle: 16,
        columnText: 16,
        gridTitle: 16,
        gridText: 12,
        notes: 14,
        graphText: 14,
        graphEdgeText: 12,
    },
    /** Geometry in cm (16:9 slide). */
    slide: { width: 28, height: 15.75 },
    content: { x: 1.2, y: 3.0, width: 25.6, height: 11.9, gap: 0.3 },
    /** `@graph` diagrams. */
    graph: {
        /** Connector kind for edges: "curve", "line", "standard" (elbows) or "lines". */
        connector: "curve",
        /** Maximum enlargement of a diagram relative to its Graphviz size. */
        maxScale: 1.5,
    },
}

export type Theme = typeof defaultTheme

export interface StyleConfig {
    theme: Theme
    styles: Record<string, StyleDef>
    tableTemplates: TableTemplate[]
    /** Inline formatting (bold, italic, code). Impress has no character styles, so these are automatic styles. */
    spanStyles: Record<string, Props>
    /** Line ends (arrows), referenced by `draw:marker-start` / `draw:marker-end`. */
    markers: Record<string, { viewBox: string; d: string }>
    /** Dash patterns, referenced by `draw:stroke-dash` (ODF `draw:stroke-dash` attributes). */
    dashes: Record<string, Props>
}

const sans: Props = { "fo:font-family": "{fonts.sans}", "style:font-family-generic": "swiss" }
const mono: Props = { "fo:font-family": "{fonts.mono}", "style:font-family-generic": "modern" }

/** Text that does not fit in its box is shrunk instead of overflowing. */
const shrink: Props = {
    "draw:auto-grow-height": "false",
    "draw:auto-grow-width": "false",
    "draw:fit-to-size": "false",
    "style:shrink-to-fit": "true",
}

const bullets: BulletDef = {
    chars: ["●", "–", "●", "–", "●", "–", "●", "–", "●"],
    color: "{colors.accent}",
    indent: 0.9,
    size: "80%",
}

function masterStyles(master: "Master" | "Section"): Record<string, StyleDef> {
    const isSection = master === "Section"
    const styles: Record<string, StyleDef> = {
        [`${master}-title`]: {
            family: "presentation",
            graphic: { "draw:stroke": "none", "draw:fill": "none", "draw:textarea-vertical-align": "middle", ...shrink },
            paragraph: { "fo:text-align": isSection ? "center" : "start" },
            text: {
                ...sans,
                "fo:font-size": isSection ? "{sizes.sectionTitle}pt" : "{sizes.title}pt",
                "fo:font-weight": "bold",
                "fo:color": isSection ? "{colors.white}" : "{colors.primary}",
            },
        },
        [`${master}-subtitle`]: {
            family: "presentation",
            graphic: { "draw:stroke": "none", "draw:fill": "none", "draw:textarea-vertical-align": "top", ...shrink },
            paragraph: { "fo:text-align": "center" },
            text: { ...sans, "fo:font-size": "{sizes.subtitle}pt", "fo:color": "{colors.subtitle}" },
        },
        [`${master}-outline1`]: {
            family: "presentation",
            graphic: { "draw:stroke": "none", "draw:fill": "none", "draw:textarea-vertical-align": "top", ...shrink },
            paragraph: { "fo:margin-top": "0.1cm", "fo:margin-bottom": "0.15cm", "fo:line-height": "105%" },
            text: { ...sans, "fo:font-size": "{sizes.list.0}pt", "fo:color": "{colors.ink}" },
            bullets,
        },
    }
    for (let level = 2; level <= 9; level++) {
        styles[`${master}-outline${level}`] = {
            family: "presentation",
            parent: `${master}-outline${level - 1}`,
            paragraph: { "fo:margin-top": "0.05cm", "fo:margin-bottom": "0.1cm" },
            text: { "fo:font-size": `{sizes.list.${level - 1}}pt` },
        }
    }
    styles[`${master}-notes`] = {
        family: "presentation",
        graphic: { "draw:stroke": "none", "draw:fill": "none" },
        paragraph: { "fo:margin-bottom": "0.2cm" },
        text: { ...sans, "fo:font-size": "{sizes.notes}pt", "fo:color": "{colors.ink}" },
    }
    styles[`${master}-background`] = { family: "presentation", graphic: { "draw:stroke": "none", "draw:fill": "none" } }
    styles[`${master}-backgroundobjects`] = { family: "presentation", graphic: { "draw:shadow": "hidden" } }
    return styles
}

function cellStyle(fill: string, color: string, bold: boolean, size: string): StyleDef {
    return {
        family: "table-cell",
        graphic: {
            "draw:fill": "solid",
            "draw:fill-color": fill,
            "draw:textarea-vertical-align": "middle",
            "fo:padding-left": "0.2cm",
            "fo:padding-right": "0.2cm",
            "fo:padding-top": "0.1cm",
            "fo:padding-bottom": "0.1cm",
        },
        paragraph: { "fo:text-align": "start", "fo:border": "0.03cm solid {colors.tableBorder}" },
        text: { ...sans, "fo:font-size": size, "fo:color": color, ...(bold ? { "fo:font-weight": "bold" } : {}) },
    }
}

function tableStyles(prefix: string, size: string): Record<string, StyleDef> {
    return {
        [`${prefix}-entete`]: cellStyle("{colors.primary}", "{colors.white}", true, size),
        [`${prefix}-cellule`]: cellStyle("{colors.white}", "{colors.ink}", false, size),
        [`${prefix}-cellule-alt`]: cellStyle("{colors.tableBand}", "{colors.ink}", false, size),
    }
}

function gridStyles(): Record<string, StyleDef> {
    const styles: Record<string, StyleDef> = {}
    defaultTheme.colors.grid.forEach((_, i) => {
        styles[`Grille-titre-${i + 1}`] = {
            family: "graphic",
            parent: "Grille-titre",
            graphic: { "draw:fill-color": `{colors.grid.${i}.0}` },
            text: { "fo:color": `{colors.grid.${i}.1}` },
        }
        styles[`Grille-texte-${i + 1}`] = {
            family: "graphic",
            parent: "Grille-texte",
            graphic: { "svg:stroke-color": `{colors.grid.${i}.0}` },
        }
    })
    return styles
}

const defaultStyles: Record<string, StyleDef> = {
    standard: {
        family: "graphic",
        graphic: {
            "draw:stroke": "none",
            "draw:fill": "none",
            "fo:padding-top": "0.1cm",
            "fo:padding-bottom": "0.1cm",
            "fo:padding-left": "0.15cm",
            "fo:padding-right": "0.15cm",
            "draw:textarea-vertical-align": "top",
        },
        paragraph: { "fo:margin-top": "0cm", "fo:margin-bottom": "0cm" },
        text: { ...sans, "fo:font-size": "18pt", "fo:color": "{colors.ink}" },
    },
    /** Plain paragraphs. */
    Texte: {
        family: "graphic",
        parent: "standard",
        graphic: shrink,
        paragraph: { "fo:margin-bottom": "0.2cm", "fo:line-height": "110%" },
        text: { "fo:font-size": "{sizes.text}pt" },
    },
    /** Path of parent headings, above the slide title. */
    "Fil-ariane": {
        family: "graphic",
        parent: "standard",
        graphic: shrink,
        text: { "fo:font-size": "{sizes.breadcrumb}pt", "fo:color": "{colors.muted}" },
    },
    /** Blockquotes (`> ...`). */
    Citation: {
        family: "graphic",
        parent: "standard",
        graphic: {
            ...shrink,
            "draw:fill": "solid",
            "draw:fill-color": "{colors.quoteBackground}",
            "draw:stroke": "solid",
            "svg:stroke-color": "{colors.primary}",
            "svg:stroke-width": "0.03cm",
            "fo:padding-left": "0.6cm",
            "fo:padding-right": "0.6cm",
            "fo:padding-top": "0.4cm",
            "fo:padding-bottom": "0.4cm",
            "draw:textarea-vertical-align": "middle",
        },
        paragraph: { "fo:line-height": "115%" },
        text: { "fo:font-size": "{sizes.quote}pt", "fo:font-style": "italic", "fo:color": "{colors.primary}" },
    },
    /** Chat prompts (```prompt). */
    Prompt: {
        family: "graphic",
        parent: "standard",
        graphic: {
            ...shrink,
            "draw:fill": "solid",
            "draw:fill-color": "{colors.promptBackground}",
            "draw:stroke": "none",
            "draw:shadow": "visible",
            "draw:shadow-offset-x": "0.08cm",
            "draw:shadow-offset-y": "0.08cm",
            "draw:shadow-color": "{colors.muted}",
            "draw:shadow-opacity": "35%",
            "fo:padding-left": "0.5cm",
            "fo:padding-right": "0.5cm",
            "fo:padding-top": "0.35cm",
            "fo:padding-bottom": "0.35cm",
            "draw:textarea-vertical-align": "middle",
            "draw:textarea-horizontal-align": "justify",
            "fo:wrap-option": "wrap",
        },
        paragraph: { "fo:text-align": "start" },
        text: { "fo:font-size": "{sizes.prompt}pt", "fo:color": "{colors.promptInk}" },
    },
    /** Other code blocks. */
    Code: {
        family: "graphic",
        parent: "Prompt",
        graphic: { "draw:fill-color": "{colors.codeBackground}" },
        text: { ...mono, "fo:font-size": "{sizes.code}pt", "fo:color": "{colors.ink}" },
    },
    Image: { family: "graphic", parent: "standard", graphic: { "draw:stroke": "none", "draw:fill": "none" } },
    "Tableau-cadre": { family: "graphic", parent: "standard", graphic: { "draw:stroke": "none", "draw:fill": "none" } },
    /** `@layout columns ...`: column headings and column text. */
    "Colonne-titre": {
        family: "graphic",
        parent: "standard",
        graphic: { ...shrink, "draw:textarea-vertical-align": "bottom" },
        paragraph: { "fo:text-align": "center" },
        text: { "fo:font-size": "{sizes.columnTitle}pt", "fo:font-weight": "bold", "fo:color": "{colors.primary}" },
    },
    "Colonne-texte": {
        family: "graphic",
        parent: "standard",
        graphic: shrink,
        paragraph: { "fo:margin-bottom": "0.15cm" },
        text: { "fo:font-size": "{sizes.columnText}pt" },
        bullets,
    },
    /** `@layout grid ...`: cell headings and cell bodies, colored by position. */
    "Grille-titre": {
        family: "graphic",
        parent: "standard",
        graphic: { ...shrink, "draw:fill": "solid", "draw:textarea-vertical-align": "middle", "fo:padding-left": "0.3cm" },
        text: { "fo:font-size": "{sizes.gridTitle}pt", "fo:font-weight": "bold" },
    },
    "Grille-texte": {
        family: "graphic",
        parent: "standard",
        graphic: {
            ...shrink,
            "draw:fill": "solid",
            "draw:fill-color": "{colors.gridBackground}",
            "draw:stroke": "solid",
            "svg:stroke-width": "0.04cm",
            "fo:padding-left": "0.3cm",
            "fo:padding-right": "0.3cm",
            "fo:padding-top": "0.2cm",
        },
        paragraph: { "fo:margin-bottom": "0.12cm" },
        text: { "fo:font-size": "{sizes.gridText}pt" },
        bullets,
    },
    ...gridStyles(),
    /** Master page decorations. */
    "Section-fond": {
        family: "graphic",
        parent: "standard",
        graphic: { "draw:fill": "solid", "draw:fill-color": "{colors.primary}", "draw:stroke": "none" },
    },
    Decor: {
        family: "graphic",
        parent: "standard",
        graphic: { "draw:fill": "solid", "draw:fill-color": "{colors.accent}", "draw:stroke": "none" },
    },
    /** `@graph` diagrams: nodes, clusters and edges. */
    "Graphe-noeud": {
        family: "graphic",
        parent: "standard",
        graphic: {
            ...shrink,
            "draw:fill": "solid",
            "draw:fill-color": "{colors.graphNode}",
            "draw:stroke": "solid",
            "svg:stroke-color": "{colors.primary}",
            "svg:stroke-width": "0.03cm",
            "draw:textarea-vertical-align": "middle",
            "draw:textarea-horizontal-align": "center",
            "fo:padding-left": "0.05cm",
            "fo:padding-right": "0.05cm",
            "fo:padding-top": "0.05cm",
            "fo:padding-bottom": "0.05cm",
        },
        paragraph: { "fo:text-align": "center" },
        text: { "fo:font-size": "{sizes.graphText}pt", "fo:color": "{colors.ink}" },
    },
    /** Nodes with `shape=plaintext` (or none). */
    "Graphe-texte": {
        family: "graphic",
        parent: "Graphe-noeud",
        graphic: { "draw:fill": "none", "draw:stroke": "none" },
    },
    /** Graph label (`graph [label=...]`). */
    "Graphe-titre": {
        family: "graphic",
        parent: "Graphe-texte",
        text: { "fo:font-weight": "bold", "fo:color": "{colors.primary}" },
    },
    "Graphe-groupe": {
        family: "graphic",
        parent: "standard",
        graphic: {
            "draw:fill": "solid",
            "draw:fill-color": "{colors.graphCluster}",
            "draw:stroke": "solid",
            "svg:stroke-color": "{colors.muted}",
            "svg:stroke-width": "0.02cm",
            "draw:textarea-vertical-align": "top",
            "draw:textarea-horizontal-align": "center",
            "draw:auto-grow-height": "false",
        },
        paragraph: { "fo:text-align": "center" },
        text: { "fo:font-size": "{sizes.graphEdgeText}pt", "fo:font-weight": "bold", "fo:color": "{colors.muted}" },
    },
    /** Edges without arrow (undirected graphs, `dir=none`). */
    "Graphe-lien-simple": {
        family: "graphic",
        parent: "standard",
        graphic: { "draw:stroke": "solid", "svg:stroke-color": "{colors.ink}", "svg:stroke-width": "0.03cm" },
        text: { "fo:font-size": "{sizes.graphEdgeText}pt", "fo:color": "{colors.ink}" },
    },
    "Graphe-lien": {
        family: "graphic",
        parent: "Graphe-lien-simple",
        graphic: { "draw:marker-end": "Fleche", "draw:marker-end-width": "0.3cm" },
    },
    /** Edges with `dir=both`. */
    "Graphe-lien-double": {
        family: "graphic",
        parent: "Graphe-lien",
        graphic: { "draw:marker-start": "Fleche", "draw:marker-start-width": "0.3cm" },
    },
    "Decor-ligne": {
        family: "graphic",
        parent: "standard",
        graphic: { "draw:stroke": "solid", "svg:stroke-color": "{colors.primary}", "svg:stroke-width": "0.04cm" },
    },
    ...masterStyles("Master"),
    ...masterStyles("Section"),
    ...tableStyles("Tableau", "{sizes.table}pt"),
    ...tableStyles("Tableau-petit", "{sizes.tableSmall}pt"),
}

export const defaultStyle: StyleConfig = {
    theme: defaultTheme,
    styles: defaultStyles,
    tableTemplates: ["Tableau", "Tableau-petit"].map(prefix => ({
        name: prefix,
        header: `${prefix}-entete`,
        body: `${prefix}-cellule`,
        bandedRows: `${prefix}-cellule-alt`,
    })),
    markers: {
        Fleche: { viewBox: "0 0 20 30", d: "M10 0l-10 30h20z" },
    },
    dashes: {
        Tirets: { "draw:style": "rect", "draw:dots1": "1", "draw:dots1-length": "0.2cm", "draw:distance": "0.15cm" },
    },
    spanStyles: {
        T_b: { "fo:font-weight": "bold" },
        T_i: { "fo:font-style": "italic" },
        T_bi: { "fo:font-weight": "bold", "fo:font-style": "italic" },
        T_code: mono,
    },
}
