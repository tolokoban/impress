#!/usr/bin/env node
/**
 * Convert teaching markdown files into LibreOffice Impress presentations.
 *
 * Usage: node scripts/impress/impress.ts file1.md [file2.md ...]
 *
 * Each `foo.md` produces `foo.odp` in the same folder, styled by `foo.style.json`
 * (created with the default style of `styles.ts` if missing, merged over it otherwise).
 *
 * Markdown conventions:
 *   # / ## / ### ...        sections and slides
 *   @hint ...               layout hint: stored verbatim in the .odp (alt-text
 *                           description of the slide title), never displayed
 *   @note ...               speaker note
 *   @note begin / @note end multi-line speaker note
 *   @layout grid 3x2        the next 6 sections (starting at the next heading) on one
 *                           slide, in a grid of 3 columns and 2 rows
 *   @layout columns 1fr 2fr auto
 *                           the next 3 sections on one slide, in columns sized by
 *                           fractions of the free width or by their content (auto)
 *                           Not followed by a heading, a layout takes the next blocks
 *                           (paragraph, list, image...) of the section instead, one per cell
 *   @graph diagram.dot      Graphviz diagram, rendered as a PNG image by the "dot" tool
 *
 * Every embedded image (graphs included) is stored as WebP (see `theme.images`).
 *   @next                   start a new slide with the same title as the current one
 *   @compact                the next table is shrunk to fit on one slide instead of being split
 *   @reveal C1,3 R1-4       the rows of the next table appear one slide after the other; the
 *                           columns (C) and rows (R) listed, both optional, are always visible
 *   ```prompt ... ```       chat prompt bubble
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { crc32, deflateRawSync } from "node:zlib"
import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline/promises"

import sharp from "sharp"

import { defaultStyle, type BackgroundImage, type BulletDef, type NumberDef, type Props, type StyleConfig, type StyleDef } from "./styles.ts"

const PT = 0.03528 // cm per point

// ---------------------------------------------------------------- terminal colors

/** ANSI styles, only when writing to a terminal and NO_COLOR is not set. */
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const ansi = (on: string, off: string) => (text: string) => (COLOR ? `\x1b[${on}m${text}\x1b[${off}m` : text)
/** File names. Ends with "normal intensity" only, so it can be nested in a colored text. */
const bold = ansi("1", "22")
/** Example of prompt for an AI agent. */
const cyan = ansi("36", "39")
/** Questions waiting for an answer. */
const yellow = ansi("93", "39")

// Style of the file being converted (see `useStyle()`).
let style: StyleConfig = defaultStyle
let sizes = style.theme.sizes
let SLIDE_W = 0
let SLIDE_H = 0
let X0 = 0
let Y0 = 0
let W = 0
let H = 0
let GAP = 0
let CENTER = false

function useStyle(config: StyleConfig) {
    style = config
    sizes = config.theme.sizes
    SLIDE_W = config.theme.slide.width
    SLIDE_H = config.theme.slide.height
    ;({ x: X0, y: Y0, width: W, height: H, gap: GAP } = config.theme.content)
    CENTER = config.theme.content.align === "center"
}

// ---------------------------------------------------------------- style files

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function isObject(v: unknown): v is Record<string, Json> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Objects are merged recursively; arrays and scalars of `over` replace those of `base`. */
function deepMerge<T>(base: T, over: unknown): T {
    if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v
    return out as T
}

/**
 * `foo.md` uses `foo.style.json`, merged over the default style.
 * If that file does not exist, it is created with the default style.
 */
function loadStyle(src: string): { config: StyleConfig; path: string; created: boolean } {
    const path = src.replace(/\.md$/i, ".style.json")
    if (!existsSync(path)) {
        writeFileSync(path, JSON.stringify(defaultStyle, null, 4) + "\n")
        return { config: defaultStyle, path, created: true }
    }
    let json: unknown
    try {
        json = JSON.parse(readFileSync(path, "utf8"))
    } catch (err) {
        throw new Error(`Invalid JSON in ${path}: ${err instanceof Error ? err.message : err}`)
    }
    if (!isObject(json)) throw new Error(`${path} must contain a JSON object`)
    return { config: deepMerge(defaultStyle, json), path, created: false }
}

/** Replace "{colors.primary}"-like placeholders with values from the theme. */
function resolveValue(value: string, where: string): string {
    return value.replace(/\{([\w.]+)\}/g, (_, path: string) => {
        let v: unknown = style.theme
        for (const key of path.split(".")) v = isObject(v) || Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined
        if (typeof v !== "string" && typeof v !== "number") throw new Error(`Unknown theme value "{${path}}" in ${where}`)
        return String(v)
    })
}

// ---------------------------------------------------------------- parsing

/** [level (0 = top), text, number of the item (numbered lists only)]. */
type ListItem = [number, string, number?]

type Block =
    | { t: "para"; text: string }
    | { t: "list"; items: ListItem[] }
    | { t: "quote"; text: string }
    | { t: "prompt" | "code"; lines: string[] }
    | TableBlock
    | { t: "image"; alt: string; src: string }
    | { t: "note"; text: string }
    | { t: "layout"; layout: Layout; cells: Section[] }

type TableBlock = {
    t: "table"
    header: string[] | null
    rows: string[][]
    /** Number of side-by-side tables the rows are spread over (1 by default), each with the header. */
    columns?: number
    /** All the rows of a table split over several slides: the column widths are computed from them. */
    ref?: string[][]
    /** Set by `@compact`: shrink the text instead of splitting the table. */
    compact?: boolean
    /** Font size in points, when it is not `sizes.table`. */
    pt?: number
    /** Set by `@reveal`: the rows appear one slide after the other. */
    reveal?: Reveal
    /** Rows revealed on the current slide (all of them when undefined). */
    shown?: Set<string[]>
}

/** `@reveal C1,3 R1-4`: what stays visible while the rows of a table are revealed. */
type Reveal = {
    /** Always visible columns (0-based). */
    cols: Set<number>
    /** Always visible rows (the row arrays of the table). */
    rows: Set<string[]>
}

/** Is this cell hidden until its row is revealed? */
function isHidden(b: TableBlock, row: string[], col: number): boolean {
    return !!b.reveal && !!b.shown && !b.shown.has(row) && !b.reveal.rows.has(row) && !b.reveal.cols.has(col)
}

/** `1,3`, `1-4`, `2,5-7`: 1-based numbers, returned 0-based. */
function parseNumbers(spec: string, where: string): number[] {
    const out: number[] = []
    for (const part of spec.split(",")) {
        const m = part.match(/^(\d+)(?:-(\d+))?$/)
        const [a, b] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [0, 0]
        if (!m || a < 1 || b < a) throw new Error(`${where}: invalid list "${spec}" (expected numbers or ranges, e.g. 1,3 or 1-4)`)
        for (let n = a; n <= b; n++) out.push(n - 1)
    }
    return out
}

/** `@layout grid 3x2` or `@layout columns 1fr 2fr auto`. */
type Layout =
    | { kind: "grid"; columns: number; rows: number; source: string }
    | { kind: "columns"; widths: (number | "auto")[]; source: string }

function cellCount(layout: Layout): number {
    return layout.kind === "grid" ? layout.columns * layout.rows : layout.widths.length
}

function parseLayout(spec: string, where: string): Layout {
    const source = `@layout ${spec}`
    const [kind, ...args] = spec.split(/\s+/).filter(Boolean)
    if (kind === "grid") {
        const m = args.join("").match(/^(\d+)[x×](\d+)$/i)
        if (!m || args.length !== 1 || Number(m[1]) < 1 || Number(m[2]) < 1)
            throw new Error(`${where}: expected "@layout grid <columns>x<rows>", got "${source}"`)
        return { kind, columns: Number(m[1]), rows: Number(m[2]), source }
    }
    if (kind === "columns") {
        if (!args.length) throw new Error(`${where}: "@layout columns" needs at least one size (e.g. 1fr 2fr auto)`)
        const widths = args.map(a => {
            if (a === "auto") return "auto" as const
            const m = a.match(/^(\d+(?:\.\d+)?)fr$/)
            if (!m || Number(m[1]) <= 0) throw new Error(`${where}: invalid column size "${a}" (only fractions like "2fr" and "auto" are allowed)`)
            return Number(m[1])
        })
        return { kind, widths, source }
    }
    throw new Error(`${where}: unknown layout "${kind ?? ""}" (expected "grid" or "columns")`)
}

class Section {
    level: number
    title: string
    parent: Section | null
    blocks: Block[] = []
    hints: string[] = []
    children: Section[] = []
    /** Set on the first section of a group laid out on a single slide. */
    layout: Layout | null = null
    /** Created by `@next`: continues the previous section on a new slide. */
    continued = false

    /** Folder of the markdown file, for relative image paths. */
    source: string

    constructor(level: number, title: string, parent: Section | null = null, source = "") {
        this.source = source
        this.level = level
        this.title = title
        this.parent = parent
    }

    path(): string[] {
        const out: string[] = []
        for (let s: Section | null = this; s && s.level > 0; s = s.parent) out.unshift(s.title)
        return out
    }
}

function stripMd(s: string): string {
    return s
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replaceAll("**", "")
        .replaceAll("__", "")
        .replace(/(?<![\p{L}\p{N}_])\*(.+?)\*(?![\p{L}\p{N}_])/gu, "$1")
        .trim()
}

/** `- item`, `* item`, `1. item` or `1) item`: [indent, number (ordered only), text]. */
const LIST_RE = /^(\s*)(?:[*-]|(\d+)[.)])\s+(.*)$/
const IMG_RE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/
const HEAD_RE = /^(#{1,6})\s+(.*)$/

function parse(md: string, file: string): Section {
    const root = new Section(0, "", null, dirname(file))
    let cur = root
    const lines = md.split("\n")
    let para: string[] = []
    let list: { t: "list"; items: ListItem[] } | null = null
    let layout: Layout | null = null
    // `@layout` followed by content instead of a heading: the next blocks fill its cells.
    let grouped: { t: "layout"; layout: Layout; cells: Section[] } | null = null
    // Line number of an `@compact` waiting for its table (0 if none).
    let compact = 0
    const dropCompact = () => {
        if (compact) console.warn(`  ! ${bold(file)}:${compact}: "@compact" is not followed by a table`)
        compact = 0
    }
    // `@reveal` waiting for its table: line number, always visible columns and rows (0-based).
    let reveal: { line: number; cols: number[]; rows: number[] } | null = null
    const dropReveal = () => {
        if (reveal) console.warn(`  ! ${bold(file)}:${reveal.line}: "@reveal" is not followed by a table`)
        reveal = null
    }

    const push = (b: Block) => {
        if (!grouped) return void cur.blocks.push(b)
        const cells = grouped.cells
        if (b.t === "note") return void (cells.length ? cells[cells.length - 1].blocks : cur.blocks).push(b)
        if (cells.length === cellCount(grouped.layout)) {
            grouped = null
            return void cur.blocks.push(b)
        }
        const cell = new Section(cur.level + 1, "", cur, root.source)
        cell.blocks.push(b)
        cells.push(cell)
    }

    const flushPara = () => {
        if (!para.length) return
        let text = ""
        para.forEach((l, j) => {
            text += l.trim()
            if (j < para.length - 1) text += l.endsWith("  ") ? "\n" : " "
        })
        push({ t: "para", text })
        para = []
    }
    const flushList = () => {
        if (list) push(list)
        list = null
    }
    const flush = () => {
        flushPara()
        flushList()
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const s = line.trim()
        let m: RegExpMatchArray | null
        if ((m = line.match(HEAD_RE))) {
            flush()
            dropCompact()
            grouped = null
            const level = m[1].length
            while (cur.level >= level) cur = cur.parent!
            const sec = new Section(level, stripMd(m[2]), cur, root.source)
            sec.layout = layout
            layout = null
            cur.children.push(sec)
            cur = sec
        } else if (s.startsWith("@layout")) {
            flush()
            grouped = null
            const spec = parseLayout(s.slice(7).trim(), `${file}:${i + 1}`)
            let j = i + 1
            while (j < lines.length && lines[j].trim() === "") j++
            if (j < lines.length && HEAD_RE.test(lines[j])) layout = spec
            else {
                grouped = { t: "layout", layout: spec, cells: [] }
                cur.blocks.push(grouped)
            }
        } else if (s === "@next") {
            flush()
            grouped = null
            // A heading right after `@next` starts the new slide by itself.
            let j = i + 1
            while (j < lines.length && lines[j].trim() === "") j++
            if (j < lines.length && HEAD_RE.test(lines[j])) continue
            if (!cur.parent) throw new Error(`${file}:${i + 1}: "@next" needs a previous heading`)
            const sec = new Section(cur.level, cur.title, cur.parent, root.source)
            sec.continued = true
            cur.parent.children.push(sec)
            cur = sec
        } else if (s === "@compact") {
            flush()
            dropCompact()
            compact = i + 1
        } else if (s === "@reveal" || s.startsWith("@reveal ")) {
            flush()
            dropReveal()
            const where = `${file}:${i + 1}`
            reveal = { line: i + 1, cols: [], rows: [] }
            for (const arg of s.slice(7).trim().split(/\s+/).filter(Boolean)) {
                const m = arg.match(/^([CR])(.+)$/i)
                if (!m) throw new Error(`${where}: expected "@reveal [C<columns>] [R<rows>]" (e.g. "@reveal C1,3 R1-4"), got "${s}"`)
                reveal[m[1].toUpperCase() === "C" ? "cols" : "rows"].push(...parseNumbers(m[2], where))
            }
        } else if (s.startsWith("@graph")) {
            flush()
            const src = s.slice(6).trim()
            const where = `${file}:${i + 1}`
            if (!src.toLowerCase().endsWith(".dot")) throw new Error(`${where}: expected "@graph <relative path of a .dot file>", got "${s}"`)
            if (!existsSync(resolve(dirname(file), src))) throw new Error(`${where}: file not found: ${src}`)
            push({ t: "image", alt: "", src })
        } else if (s.startsWith("@hint")) {
            flush()
            cur.hints.push(s)
        } else if (s === "@note begin") {
            flush()
            const buf: string[] = []
            for (i++; i < lines.length && lines[i].trim() !== "@note end"; i++) buf.push(lines[i])
            push({ t: "note", text: buf.join("\n").trim() })
        } else if (s.startsWith("@note")) {
            flush()
            push({ t: "note", text: s.slice(5).trim() })
        } else if (s.startsWith("```")) {
            flush()
            const lang = s.slice(3).trim()
            const buf: string[] = []
            for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) buf.push(lines[i])
            push({ t: lang === "prompt" ? "prompt" : "code", lines: buf })
        } else if (s.startsWith("|")) {
            flush()
            const rows: string[][] = []
            for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
                const row = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "")
                rows.push(row.split("|").map(c => c.trim()))
            }
            i--
            let header: string[] | null = rows[0]
            const body = rows.slice(1).filter(r => !/^[\s:\-|]*$/.test(r.join("")))
            if (header.every(c => c === "" || c === ".")) header = null
            const table: TableBlock = { t: "table", header, rows: body }
            if (compact) table.compact = true
            compact = 0
            if (reveal) {
                const { cols, rows: fixed } = reveal as { cols: number[]; rows: number[] }
                table.reveal = { cols: new Set(cols), rows: new Set(fixed.flatMap(n => (body[n] ? [body[n]] : []))) }
                reveal = null
            }
            push(table)
        } else if (s.startsWith(">")) {
            flush()
            const buf: string[] = []
            for (; i < lines.length && lines[i].trim().startsWith(">"); i++) buf.push(lines[i].trim().slice(1).trim())
            i--
            push({ t: "quote", text: buf.join(" ") })
        } else if ((m = line.match(IMG_RE))) {
            flush()
            push({ t: "image", alt: m[1], src: m[2] })
        } else if ((m = line.match(LIST_RE))) {
            flushPara()
            list ??= { t: "list", items: [] }
            const item: ListItem = [Math.floor(m[1].length / 2), m[3].trim()]
            if (m[2] !== undefined) item.push(Number(m[2]))
            list.items.push(item)
        } else if (s === "") {
            flushPara()
            // A blank line ends a list unless the next non-blank line is a list item.
            let j = i + 1
            while (j < lines.length && lines[j].trim() === "") j++
            if (list && !(j < lines.length && LIST_RE.test(lines[j]))) flushList()
        } else if (list && line.startsWith(" ")) {
            const items: ListItem[] = list.items
            items[items.length - 1][1] += " " + s
        } else {
            flushList()
            para.push(line)
        }
    }
    flush()
    dropCompact()
    dropReveal()
    if (layout) console.warn(`  ! ${bold(file)}: "${(layout as Layout).source}" is not followed by any section`)
    return root
}

// ---------------------------------------------------------------- inline

type Run = { text: string; fmt: Set<string>; href: string | null }

const INLINE_PATTERNS: [string, RegExp][] = [
    ["link", /\[([^\]]+)\]\(([^)]+)\)/],
    ["auto", /<(https?:\/\/[^>]+)>/],
    ["bi", /\*\*\*(.+?)\*\*\*/s],
    ["b", /\*\*(.+?)\*\*/s],
    ["i", /(?<![\p{L}\p{N}_*])\*(?!\s)(.+?)(?<!\s)\*(?![\p{L}\p{N}_*])/su],
    ["code", /`([^`]+)`/],
]

function inline(s: string, fmt = new Set<string>(), href: string | null = null): Run[] {
    s = s.replace("$\\text{XX}^\\text{e}$", "XXᵉ")
    const runs: Run[] = []
    while (s) {
        let best: [string, RegExpExecArray] | null = null
        for (const [kind, rx] of INLINE_PATTERNS) {
            const m = rx.exec(s)
            if (m && (!best || m.index < best[1].index)) best = [kind, m]
        }
        if (!best) {
            runs.push({ text: s, fmt, href })
            break
        }
        const [kind, m] = best
        if (m.index) runs.push({ text: s.slice(0, m.index), fmt, href })
        const add = (...k: string[]) => new Set([...fmt, ...k])
        if (kind === "link") runs.push(...inline(m[1], fmt, m[2]))
        else if (kind === "auto") runs.push({ text: m[1], fmt, href: m[1] })
        else if (kind === "bi") runs.push(...inline(m[1], add("b", "i"), href))
        else if (kind === "code") runs.push({ text: m[1], fmt: add("code"), href })
        else runs.push(...inline(m[1], add(kind), href))
        s = s.slice(m.index + m[0].length)
    }
    return runs
}

function esc(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

/** Escape text for ODF, preserving consecutive spaces, tabs and line breaks. */
function xmlText(s: string): string {
    return s
        .split("\n")
        .map(line =>
            esc(line)
                .replace(/ {2,}|^ +/g, (m, offset: number) => {
                    if (offset === 0) return `<text:s text:c="${m.length}"/>`
                    return " " + (m.length > 1 ? `<text:s text:c="${m.length - 1}"/>` : "")
                })
                .replaceAll("\t", "<text:tab/>"),
        )
        .join("<text:line-break/>")
}

function spanStyle(fmt: Set<string>): string | null {
    if (fmt.has("code")) return "T_code"
    if (fmt.has("b") && fmt.has("i")) return "T_bi"
    if (fmt.has("b")) return "T_b"
    if (fmt.has("i")) return "T_i"
    return null
}

function runsXml(text: string): string {
    return inline(text)
        .map(({ text, fmt, href }) => {
            let x = xmlText(text)
            const st = spanStyle(fmt)
            if (st) x = `<text:span text:style-name="${st}">${x}</text:span>`
            if (href) x = `<text:a xlink:type="simple" xlink:href="${esc(href)}">${x}</text:a>`
            return x
        })
        .join("")
}

function plainLen(text: string): number {
    return inline(text).reduce((n, r) => n + r.text.length, 0)
}

// ---------------------------------------------------------------- measuring

function textH(nChars: number, width: number, pt: number, lh = 1.25): number {
    const cpl = Math.max(1, width / (pt * PT * 0.5))
    return Math.max(1, Math.ceil(nChars / cpl)) * pt * PT * lh
}

function paraH(text: string, width: number, pt = sizes.text): number {
    return text.split("\n").reduce((h, p) => h + textH(plainLen(p), width, pt), 0) + 0.25
}

function listH(items: ListItem[], width: number): number {
    let h = 0
    for (const [lvl, txt] of items) h += textH(plainLen(txt), width - 0.9 * (lvl + 1), sizes.list[Math.min(lvl, 8)]) + 0.3
    return h + 0.1
}

function promptSize(lines: string[], width: number): [number, number] {
    const pt = sizes.prompt
    const longest = Math.max(10, ...lines.map(l => l.length))
    const w = Math.min(width, Math.max(8, longest * pt * PT * 0.5 + 1.4))
    const h = lines.reduce((acc, l) => acc + textH(l.length, w - 1, pt), 0) + 0.9
    return [w, h]
}

// ---------------------------------------------------------------- images in table cells

/** Folder of the markdown file being converted, for the relative paths of cell images. */
let mdDir = "."

/** Image of a table cell, sized in em (1em = the font size of the table, 16px in HTML terms). */
type CellImage = { src: string; alt: string; w: number; h: number }
type Cell = { text: string; imgs: CellImage[] }

/** `<img src="..." width="48" height="48">` or `![alt](src)`. */
const CELL_IMG_RE = /<img\s[^>]*>|!\[([^\]]*)\]\(([^)\s]+)\)/gi
/** Pixels per em: the HTML sizes of the markdown assume a 16px font. */
const PX_PER_EM = 16
/** Height (in em) of a cell image without any size. */
const DEFAULT_IMG_EM = 2
/** Horizontal gap (in em) between the images of a cell, and between them and the text. */
const IMG_GAP_EM = 0.3
/** Horizontal padding of the table cells (both sides), in cm. */
const CELL_PAD_X = 0.4

const cellCache = new Map<string, Cell>()

function htmlAttr(tag: string, name: string): string | undefined {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** Split a table cell into its text and its images (HTML `<img>` or markdown `![]()`). */
function cell(s: string): Cell {
    let c = cellCache.get(s)
    if (c) return c
    const imgs: CellImage[] = []
    const text = s
        .replace(CELL_IMG_RE, (tag: string, mdAlt?: string, mdSrc?: string) => {
            const src = mdSrc ?? htmlAttr(tag, "src")
            if (!src) return tag
            const px = (name: string) => {
                const v = mdSrc ? undefined : htmlAttr(tag, name)
                const n = v === undefined ? NaN : parseFloat(v)
                return n > 0 ? n / PX_PER_EM : undefined
            }
            let w = px("width")
            let h = px("height")
            if (w === undefined || h === undefined) {
                const [iw, ih] = imageSize(resolve(mdDir, src))
                if (w !== undefined) h = (w * ih) / iw
                else if (h !== undefined) w = (h * iw) / ih
                else [w, h] = [(DEFAULT_IMG_EM * iw) / ih, DEFAULT_IMG_EM]
            }
            imgs.push({ src, alt: mdAlt ?? htmlAttr(tag, "alt") ?? "", w: w!, h: h! })
            return " "
        })
        .replace(/\s+/g, " ")
        .trim()
    c = { text, imgs }
    cellCache.set(s, c)
    return c
}

/**
 * Size (in cm) of the images of a cell at `pt` points, side by side: [scale, width, height].
 * They are shrunk to fit in the column if needed (`scale` < 1).
 */
function cellImgBox(c: Cell, colW: number, pt: number): [number, number, number] {
    if (!c.imgs.length) return [1, 0, 0]
    const em = pt * PT
    const w = (c.imgs.reduce((a, i) => a + i.w, 0) + IMG_GAP_EM * (c.imgs.length - 1)) * em
    const h = Math.max(...c.imgs.map(i => i.h)) * em
    const room = Math.max(colW - CELL_PAD_X - (c.text ? 2 * em : 0), 0.1)
    const scale = Math.min(1, room / w)
    return [scale, w * scale, h * scale]
}

/** Width (in cm) taken by the images of a cell before its text, gap included. */
function cellTextIndent(c: Cell, colW: number, pt: number): number {
    const [, w] = cellImgBox(c, colW, pt)
    return w && c.text ? w + IMG_GAP_EM * pt * PT : 0
}

/**
 * Advance widths (in 1/1000 em) of the printable ASCII characters, from space to "~", in
 * Liberation Sans Bold (the metrics of Arial Bold): the font of the table headers.
 */
const BOLD_WIDTHS = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
    611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

/** Width (in cm) of a word in bold at `pt` points, a bit overestimated to be safe. */
function boldWordW(word: string, pt: number): number {
    let units = 0
    for (const ch of word) {
        // Accented letters are as wide as their base letter.
        const code = ch.normalize("NFD").charCodeAt(0)
        units += code >= 32 && code <= 126 ? BOLD_WIDTHS[code - 32] : 650
    }
    return (units / 1000) * pt * PT * 1.05
}

/**
 * Do the words of the header of a `@compact` or `@reveal` table fit in their columns, at the
 * size of the table, on a slide of full width? Several words may wrap, but no word is cut.
 */
function headerFits(b: TableBlock): boolean {
    if (!b.header) return true
    const pt = b.pt ?? sizes.table
    const cols = tableBlockCols(b, W)
    return b.header.every((s, i) => {
        const c = cell(s)
        const room = cols[i] - CELL_PAD_X - cellTextIndent(c, cols[i], pt)
        const words = inline(c.text)
            .map(r => r.text)
            .join("")
            .split(/\s+/)
            .filter(Boolean)
        return words.every(w => boldWordW(w, pt) <= room)
    })
}

function tableCols(header: string[] | null, rows: string[][], width: number): number[] {
    const all = header ? [header, ...rows] : rows
    const ncol = Math.max(...all.map(r => r.length))
    const lens = new Array<number>(ncol).fill(0)
    for (const r of all)
        r.forEach((s, c) => {
            const { text, imgs } = cell(s)
            // An em is about two characters (see `textH()`).
            const imgLen = imgs.length ? 2 * (imgs.reduce((a, i) => a + i.w, 0) + IMG_GAP_EM * imgs.length) : 0
            lens[c] = Math.max(lens[c], Math.min(plainLen(text), 45) + imgLen + 4)
        })
    const tot = lens.reduce((a, b) => a + b, 0)
    return lens.map(l => (width * l) / tot)
}

function rowH(r: string[], cols: number[], pt: number): number {
    // Below the size of small tables (`@compact`), the room around the text shrinks too, down to the cell padding.
    const pad = pt >= sizes.tableSmall ? 0.35 : 0.2 + (0.15 * pt) / sizes.tableSmall
    return (
        Math.max(
            ...r.map((s, i) => {
                const c = cell(s)
                const th = c.text ? textH(plainLen(c.text), cols[i] - CELL_PAD_X - cellTextIndent(c, cols[i], pt), pt) : 0
                return Math.max(th, cellImgBox(c, cols[i], pt)[2])
            }),
        ) + pad
    )
}

function tableH(header: string[] | null, rows: string[][], width: number, pt: number, cols?: number[]): number {
    cols ??= tableCols(header, rows, width)
    return (header ? [header, ...rows] : rows).reduce((h, r) => h + rowH(r, cols, pt), 0)
}

/** Horizontal gap between the side-by-side parts of a table. */
const TABLE_GAP = 0.6

/** Rows of each side-by-side part of a table block. */
function tableParts(b: TableBlock): string[][][] {
    const n = b.columns ?? 1
    if (n <= 1) return [b.rows]
    const per = Math.ceil(b.rows.length / n)
    return Array.from({ length: n }, (_, i) => b.rows.slice(i * per, (i + 1) * per)).filter(p => p.length)
}

function tablePartW(b: TableBlock, width: number): number {
    const n = b.columns ?? 1
    return (width - TABLE_GAP * (n - 1)) / n
}

/** Column widths of each part, the same for all the parts of a table. */
function tableBlockCols(b: TableBlock, width: number): number[] {
    return tableCols(b.header, b.ref ?? b.rows, tablePartW(b, width))
}

function tableBlockH(b: TableBlock, width: number): number {
    const cols = tableBlockCols(b, width)
    const pw = tablePartW(b, width)
    return Math.max(...tableParts(b).map(rows => tableH(b.header, rows, pw, b.pt ?? sizes.table, cols)))
}

function blockH(b: Block, width: number): number {
    switch (b.t) {
        case "para":
            return paraH(b.text, width)
        case "list":
            return listH(b.items, width)
        case "quote":
            return paraH(b.text, width - 1.2, sizes.quote) + 0.8
        case "prompt":
        case "code":
            return promptSize(b.lines, width)[1]
        case "table":
            return tableBlockH(b, width)
        default:
            return 0
    }
}

function imageSize(path: string): [number, number] {
    const ext = extname(path).toLowerCase()
    if (ext === ".dot") return graphPng(path).size
    const data = readFileSync(path)
    if (ext === ".svg") {
        const head = data.subarray(0, 4000).toString("utf8")
        const vb = head.match(/viewBox="[\d.\s-]+?\s([\d.]+)\s([\d.]+)"/)
        if (vb) return [Number(vb[1]), Number(vb[2])]
        const w = head.match(/width="([\d.]+)/)
        const h = head.match(/height="([\d.]+)/)
        return [Number(w?.[1] ?? 100), Number(h?.[1] ?? 100)]
    }
    if (ext === ".png") return [data.readUInt32BE(16), data.readUInt32BE(20)]
    if (ext === ".webp") {
        const chunk = data.toString("ascii", 12, 16)
        if (chunk === "VP8 ") return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff]
        if (chunk === "VP8L") {
            const [b0, b1, b2, b3] = data.subarray(21, 25)
            return [1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0xf) << 10))]
        }
        if (chunk === "VP8X") return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)]
    }
    if (ext === ".jpg" || ext === ".jpeg") {
        for (let i = 2; i < data.length - 9; ) {
            const marker = data[i + 1]
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
                return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)]
            i += 2 + data.readUInt16BE(i + 2)
        }
    }
    throw new Error(`Unsupported image: ${path}`)
}

function fit(iw: number, ih: number, bw: number, bh: number): [number, number] {
    const r = Math.min(bw / iw, bh / ih)
    return [iw * r, ih * r]
}

// ---------------------------------------------------------------- graphviz

interface GraphPng {
    /** PNG rendered by Graphviz. */
    png: Buffer
    /** Natural size in cm. */
    size: [number, number]
}

/** Rendered diagrams, keyed by the arguments of `dot` (which include the theme). */
const graphCache = new Map<string, GraphPng>()

const IS_WINDOWS = process.platform === "win32"

/** Path of the Graphviz `dot` executable: `undefined` until searched, `null` if not found. */
let dotPath: string | null | undefined

function hasCommand(cmd: string): boolean {
    const r = IS_WINDOWS
        ? spawnSync("where", [cmd], { stdio: "ignore" })
        : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" })
    return r.status === 0
}

/** `dot` from the PATH, or from the usual install folders (a fresh install may not be in the PATH yet). */
function findDot(): string | null {
    if (hasCommand("dot")) return "dot"
    const candidates = IS_WINDOWS
        ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]
              .filter((d): d is string => !!d)
              .map(d => join(d, "Graphviz", "bin", "dot.exe"))
        : ["/opt/homebrew/bin/dot", "/usr/local/bin/dot", "/opt/local/bin/dot", "/usr/bin/dot"]
    return candidates.find(p => existsSync(p)) ?? null
}

/** The command installing Graphviz on this system, if a known package manager is available. */
function installCommand(): string[] | null {
    const sudo = !IS_WINDOWS && process.getuid?.() !== 0 && hasCommand("sudo") ? ["sudo"] : []
    const managers: [string, string[]][] =
        process.platform === "darwin"
            ? [
                  ["brew", ["brew", "install", "graphviz"]],
                  ["port", [...sudo, "port", "install", "graphviz"]],
              ]
            : IS_WINDOWS
              ? [
                    ["winget", ["winget", "install", "--id", "Graphviz.Graphviz", "-e", "--accept-package-agreements", "--accept-source-agreements"]],
                    ["choco", ["choco", "install", "graphviz", "-y"]],
                    ["scoop", ["scoop", "install", "graphviz"]],
                ]
              : [
                    ["apt-get", [...sudo, "apt-get", "install", "-y", "graphviz"]],
                    ["dnf", [...sudo, "dnf", "install", "-y", "graphviz"]],
                    ["yum", [...sudo, "yum", "install", "-y", "graphviz"]],
                    ["pacman", [...sudo, "pacman", "-S", "--noconfirm", "graphviz"]],
                    ["zypper", [...sudo, "zypper", "install", "-y", "graphviz"]],
                    ["apk", [...sudo, "apk", "add", "graphviz"]],
                    ["brew", ["brew", "install", "graphviz"]],
                ]
    return managers.find(([cmd]) => hasCommand(cmd))?.[1] ?? null
}

/**
 * Make sure the Graphviz `dot` tool is available, offering to install it if it is not.
 * Searched once per run; `graphPng()` fails with an explanation if it is still missing.
 */
async function ensureDot() {
    if (dotPath !== undefined) return
    dotPath = findDot()
    if (dotPath) return
    console.log("  ! @graph needs the Graphviz \"dot\" tool, which is not installed on this machine.")
    const cmd = installCommand()
    if (!cmd) {
        console.log("    Install Graphviz (https://graphviz.org/download/), then run again.")
        return
    }
    const shown = cmd.join(" ")
    if (!process.stdin.isTTY) {
        console.log(`    Install it with:  ${shown}`)
        return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(yellow(`    Install it now with "${shown}"? [Y/n] `))).trim().toLowerCase()
    rl.close()
    if (answer && !["y", "yes", "o", "oui"].includes(answer)) return
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: IS_WINDOWS })
    if (r.status !== 0) console.log(`    Installation failed${r.error ? `: ${r.error.message}` : ""}.`)
    dotPath = findDot()
    if (dotPath) console.log(`    Graphviz installed (${dotPath}).`)
    else if (r.status === 0) console.log("    Graphviz is installed, but \"dot\" is not found yet: open a new terminal and run again.")
}

/** Does this markdown use `@graph` (outside code blocks)? */
function usesGraph(src: string): boolean {
    let fenced = false
    for (const line of readFileSync(src, "utf8").split(/\r?\n/)) {
        const s = line.trim()
        if (s.startsWith("```")) fenced = !fenced
        else if (!fenced && s.startsWith("@graph")) return true
    }
    return false
}

/** An argument as typed in a shell, quoted when needed. */
function shellArg(arg: string): string {
    return /^[\w@%+=:,./#-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
}

/**
 * Index just after the `{` opening the body of the root graph of a DOT source
 * (skipping comments and quoted strings), or -1 if there is none.
 */
function dotBodyStart(dot: string): number {
    let i = 0
    let lineStart = true
    while (i < dot.length) {
        const c = dot[i]
        if (lineStart && c === "#") {
            // Preprocessor-like line, ignored by Graphviz.
            const end = dot.indexOf("\n", i)
            i = end < 0 ? dot.length : end
            continue
        }
        if (c === "\n") lineStart = true
        else if (!/\s/.test(c)) lineStart = false
        if (c === "/" && dot[i + 1] === "/") {
            const end = dot.indexOf("\n", i)
            i = end < 0 ? dot.length : end
            continue
        }
        if (c === "/" && dot[i + 1] === "*") {
            const end = dot.indexOf("*/", i + 2)
            i = end < 0 ? dot.length : end + 2
            continue
        }
        if (c === '"') {
            i++
            while (i < dot.length && dot[i] !== '"') i += dot[i] === "\\" ? 2 : 1
            i++
            continue
        }
        if (c === "<") {
            // HTML-like ID: balanced angle brackets.
            let depth = 0
            do {
                if (dot[i] === "<") depth++
                else if (dot[i] === ">") depth--
                i++
            } while (i < dot.length && depth > 0)
            continue
        }
        if (c === "{") return i + 1
        i++
    }
    return -1
}

/** A DOT attribute list: `[a="x", b="y"]`. */
function dotAttrs(attrs: Record<string, string | number>): string {
    return `[${Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, "\\$1")}"`)
        .join(", ")}]`
}

/**
 * Render a .dot file as PNG with Graphviz (its own Cairo renderer, as in DOT viewers:
 * LibreOffice's SVG import changes the look of Graphviz SVGs), using the fonts and colors of the
 * current style. They are inserted as `graph`/`node`/`edge` default statements at the very
 * beginning of the root graph body, so every attribute set in the .dot file (including its own
 * `node [...]` / `edge [...]` defaults) still takes precedence. They are NOT given on the command
 * line: Graphviz's `-N`/`-E` options override the defaults declared in the file.
 * The resolution is `theme.graph.dpi`.
 */
function graphPng(path: string): GraphPng {
    if (!dotPath) throw new Error(`${path}: the Graphviz "dot" tool is required by @graph (https://graphviz.org/download/)`)
    const font = style.theme.fonts.sans.replace(/'/g, "")
    const { colors } = style.theme
    const dpi = style.theme.graph.dpi
    const source = readFileSync(path, "utf8")
    const at = dotBodyStart(source)
    if (at < 0) throw new Error(`${path}: no graph body found (expected "graph { ... }" or "digraph { ... }")`)
    const defaults = [
        `graph ${dotAttrs({
            bgcolor: "transparent",
            fontname: font,
            fontsize: sizes.graphEdgeText,
            fontcolor: colors.primary,
            style: "filled",
            fillcolor: colors.graphCluster,
            pencolor: colors.muted,
        })};`,
        `node ${dotAttrs({
            fontname: font,
            fontsize: sizes.graphText,
            fontcolor: colors.ink,
            style: "filled",
            fillcolor: colors.graphNode,
            color: colors.primary,
        })};`,
        `edge ${dotAttrs({
            fontname: font,
            fontsize: sizes.graphEdgeText,
            fontcolor: colors.ink,
            color: colors.ink,
        })};`,
    ].join(" ")
    const input = `${source.slice(0, at)} ${defaults}\n${source.slice(at)}`
    // The dpi stays on the command line: it is not a matter of style, the file must not change it.
    const args = ["-Tpng", `-Gdpi=${dpi}`]
    const key = [...args, input].join("\0")
    let graph = graphCache.get(key)
    if (graph) return graph
    console.log(`  ${bold(cyan("> "))}${bold([dotPath, ...args].map(shellArg).join(" "))} < ${shellArg(path)} ${cyan("(with the theme defaults)")}`)
    const r = spawnSync(dotPath, args, { input, maxBuffer: 256 * 1024 * 1024 })
    if (r.error || r.status !== 0) {
        throw new Error(`Graphviz failed on ${path}: ${r.error?.message ?? r.stderr.toString("utf8").trim()}`)
    }
    const png = r.stdout
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error(`Graphviz did not produce a PNG for ${path}`)
    const cmPerPixel = 2.54 / dpi
    graph = { png, size: [png.readUInt32BE(16) * cmPerPixel, png.readUInt32BE(20) * cmPerPixel] }
    graphCache.set(key, graph)
    return graph
}

// ---------------------------------------------------------------- layout

const MIME: Record<string, string> = {
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

interface Picture {
    href: string
    /** Original data (PNG for graphs), encoded as WebP by `encodePictures()`. */
    data: Buffer
    /** Natural size: in cm for graphs, in pixels (or SVG units) otherwise. Only the ratio matters for images. */
    size: [number, number]
}

/**
 * Encode the pictures as WebP (`theme.images.quality`), shrunk so that their longest side
 * is at most `theme.images.maxSize` pixels. SVG images are rasterized at that size too.
 * A WebP already small enough is kept as is, to avoid losing quality twice.
 */
async function encodePictures(pics: Picture[]) {
    const { quality, maxSize } = style.theme.images
    await Promise.all(
        pics.map(async pic => {
            const input = pic.data
            const isSvg = /^\s*(<\?xml|<svg|<!--|<!DOCTYPE)/i.test(input.subarray(0, 256).toString("utf8"))
            let density: number | undefined
            if (isSvg) {
                // Rasterize at maxSize pixels for the longest side (72 dpi = 1 SVG unit per pixel).
                const longest = Math.max(pic.size[0], pic.size[1], 1)
                density = Math.min(Math.max((72 * maxSize) / longest, 1), 100000)
            }
            const img = sharp(input, { density, limitInputPixels: false })
            const meta = await img.metadata()
            const big = Math.max(meta.width ?? 0, meta.height ?? 0) > maxSize
            if (meta.format === "webp" && !big) return
            pic.data = await img
                .rotate() // apply the EXIF orientation of photos
                .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
                .webp({ quality })
                .toBuffer()
        }),
    )
}

type Page = { master: string; shapes: string[]; notes: string[] }

const f2 = (n: number) => n.toFixed(2)

/**
 * The content of one slide, once per step of its `@reveal` tables: the first step shows their
 * header and their always visible cells, each following step reveals one more row (tables in
 * the order of the slide, rows in reading order). Rows with nothing to reveal are skipped.
 */
function revealSteps(content: Block[]): Block[][] {
    const order = content.flatMap(b =>
        b.t === "table" && b.reveal ? b.rows.filter(r => !b.reveal!.rows.has(r) && r.some((c, i) => c !== "" && !b.reveal!.cols.has(i))) : [],
    )
    if (!content.some(b => b.t === "table" && b.reveal)) return [content]
    return Array.from({ length: order.length + 1 }, (_, k) => {
        const shown = new Set(order.slice(0, k))
        return content.map(b => (b.t === "table" && b.reveal ? { ...b, shown } : b))
    })
}

class Builder {
    base: string
    pictures = new Map<string, Picture>()
    pages: Page[] = []
    colStyles = new Map<string, string>()
    rowStyles = new Map<string, string>()
    paraStyles = new Map<string, string>()
    /** Hints waiting to be attached to the next slide title. */
    pendingHints: string[] = []

    constructor(base: string) {
        this.base = base
        mdDir = base
        cellCache.clear()
    }

    // -- resources
    picture(src: string): Picture {
        let pic = this.pictures.get(src)
        if (!pic) {
            const path = resolve(this.base, src)
            const isGraph = extname(src).toLowerCase() === ".dot"
            let name = `${basename(src, extname(src))}.webp`
            while ([...this.pictures.values()].some(p => p.href === `Pictures/${name}`)) name = `_${name}`
            const graph = isGraph ? graphPng(path) : null
            pic = { href: `Pictures/${name}`, data: graph ? graph.png : readFileSync(path), size: graph ? graph.size : imageSize(path) }
            this.pictures.set(src, pic)
        }
        return pic
    }

    colStyle(w: number): string {
        const key = f2(w)
        if (!this.colStyles.has(key)) this.colStyles.set(key, `co${this.colStyles.size + 1}`)
        return this.colStyles.get(key)!
    }

    /**
     * Automatic paragraph style setting the font size (in points) of a `@compact` table,
     * and the left margin (in cm) leaving room for the images of a cell.
     */
    paraStyle(pt: number, indent = 0): string {
        const key = indent ? `${f2(pt)}/${f2(indent)}` : f2(pt)
        if (!this.paraStyles.has(key)) this.paraStyles.set(key, `Pt${this.paraStyles.size + 1}`)
        return this.paraStyles.get(key)!
    }

    rowStyle(h: number): string {
        const key = f2(h)
        if (!this.rowStyles.has(key)) this.rowStyles.set(key, `ro${this.rowStyles.size + 1}`)
        return this.rowStyles.get(key)!
    }

    // -- shapes
    static geom(x: number, y: number, w: number, h: number): string {
        return `svg:x="${f2(x)}cm" svg:y="${f2(y)}cm" svg:width="${f2(w)}cm" svg:height="${f2(h)}cm"`
    }

    frame(style: string, x: number, y: number, w: number, h: number, inner: string, pres?: string, desc = ""): string {
        const attrs = pres
            ? `presentation:style-name="${style}" presentation:class="${pres}" presentation:user-transformed="true"`
            : `draw:style-name="${style}"`
        return `<draw:frame ${attrs} ${Builder.geom(x, y, w, h)}><draw:text-box>${inner}</draw:text-box>${desc}</draw:frame>`
    }

    /** Alt-text description carrying the pending `@hint` lines, invisible on the slide. */
    takeHints(): string {
        if (!this.pendingHints.length) return ""
        const desc = `<svg:desc>${esc(this.pendingHints.join("\n"))}</svg:desc>`
        this.pendingHints = []
        return desc
    }

    /**
     * Lists of a frame using the style `frameStyle`. Bullet-only lists take their bullets from that
     * style. Lists with numbered items name the list styles `<frameStyle>-numbers` and
     * `<frameStyle>-bullets` (see `listStylesXml()`) on every nested list.
     */
    listXml(items: ListItem[], frameStyle: string): string {
        const holder = listStyleHolder(frameStyle)
        const styled = holder !== null && items.some(it => it[2] !== undefined)
        const out: string[] = []
        // For each open list: is it numbered?
        const open: boolean[] = []
        const close = () => {
            out.push("</text:list-item></text:list>")
            open.pop()
        }
        for (const [lvl, txt, num] of items) {
            const ordered = num !== undefined
            while (open.length > lvl + 1) close()
            if (open.length === lvl + 1) {
                if (open[lvl] === ordered) out.push("</text:list-item><text:list-item>")
                else close()
            }
            while (open.length < lvl + 1) {
                const name = styled ? ` text:style-name="${esc(holder)}-${ordered ? "numbers" : "bullets"}"` : ""
                const start = ordered && open.length === lvl && num !== 1 ? ` text:start-value="${num}"` : ""
                out.push(`<text:list${name}><text:list-item${start}>`)
                open.push(ordered)
            }
            out.push(`<text:p>${runsXml(txt)}</text:p>`)
        }
        while (open.length) close()
        return out.join("")
    }

    tableXml(
        header: string[] | null,
        rows: string[][],
        x: number,
        y: number,
        width: number,
        pt: number,
        small = false,
        cols?: number[],
        hidden: (row: string[], col: number) => boolean = () => false,
    ): string {
        cols ??= tableCols(header, rows, width)
        const prefix = small ? "Tableau-petit" : "Tableau"
        // A size other than the one of the cell styles (`@compact`) needs a paragraph style.
        const defaultPt = pt === (small ? sizes.tableSmall : sizes.table)
        const para = (indent: number) => (defaultPt && !indent ? "" : ` text:style-name="${this.paraStyle(pt, indent)}"`)
        // Images of the cells, drawn over the table: a table cell of Impress only holds text.
        const overlays: string[] = []
        const parts = [
            `<draw:frame draw:style-name="Tableau-cadre" ${Builder.geom(x, y, width, tableH(header, rows, width, pt, cols))}>`,
            `<table:table table:template-name="${prefix}" table:use-first-row-styles="${header ? "true" : "false"}" table:use-banding-rows-styles="true">`,
            ...cols.map(cw => `<table:table-column table:style-name="${this.colStyle(cw)}"/>`),
        ]
        const all: [string, string[]][] = [
            ...(header ? [["entete", header] as [string, string[]]] : []),
            ...rows.map((r, i): [string, string[]] => [i % 2 === 0 ? "cellule" : "cellule-alt", r]),
        ]
        let cy = y
        for (const [kind, r] of all) {
            const rh = rowH(r, cols, pt)
            parts.push(`<table:table-row table:style-name="${this.rowStyle(rh)}">`)
            let cx = x
            cols.forEach((cw, i) => {
                // A hidden cell keeps the size of its content, so the table does not move when it shows up.
                const c = kind !== "entete" && hidden(r, i) ? { text: "", imgs: [] } : cell(r[i] ?? "")
                const indent = cellTextIndent(c, cw, pt)
                parts.push(`<table:table-cell table:style-name="${prefix}-${kind}"><text:p${para(indent)}>${runsXml(c.text)}</text:p></table:table-cell>`)
                if (c.imgs.length) {
                    const [scale, iw] = cellImgBox(c, cw, pt)
                    const em = pt * PT * scale
                    // Alone in its cell, an image is centered; otherwise it comes before the text.
                    let ix = c.text ? cx + CELL_PAD_X / 2 : cx + (cw - iw) / 2
                    for (const img of c.imgs) {
                        const [w, h] = [img.w * em, img.h * em]
                        overlays.push(this.imageXml(img.src, ix, cy + (rh - h) / 2, w, h, img.alt))
                        ix += w + IMG_GAP_EM * em
                    }
                }
                cx += cw
            })
            parts.push("</table:table-row>")
            cy += rh
        }
        parts.push("</table:table></draw:frame>")
        return parts.join("") + overlays.join("")
    }

    imageXml(src: string, x: number, y: number, w: number, h: number, alt = ""): string {
        const { href, size } = this.picture(src)
        // Do not blow small diagrams up: their text would become huge.
        const maxScale = style.theme.graph.maxScale
        if (extname(src).toLowerCase() === ".dot" && w > size[0] * maxScale) {
            const [fw, fh] = fit(size[0], size[1], size[0] * maxScale, size[1] * maxScale)
            x += (w - fw) / 2
            y += (h - fh) / 2
            w = fw
            h = fh
        }
            return (
            `<draw:frame draw:style-name="Image" ${Builder.geom(x, y, w, h)}>` +
            `<draw:image xlink:href="${esc(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
            (alt ? `<svg:title>${esc(alt)}</svg:title>` : "") +
            `</draw:frame>`
        )
    }

    promptXml(lines: string[], x: number, y: number, w: number, h: number, style = "Prompt"): string {
        const paras = lines.map(l => `<text:p>${xmlText(l)}</text:p>`).join("")
        return (
            `<draw:custom-shape draw:style-name="${style}" ${Builder.geom(x, y, w, h)}>${paras}` +
            `<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="round-rectangle" draw:modifiers="1800"/>` +
            `</draw:custom-shape>`
        )
    }

    blockXml(b: Block, x: number, y: number, w: number, h: number): string {
        switch (b.t) {
            case "para":
                return this.frame("Texte", x, y, w, h, `<text:p>${runsXml(b.text)}</text:p>`)
            case "list":
                return this.frame("Master-outline1", x, y, w, h, this.listXml(b.items, "Master-outline1"), "outline")
            case "quote":
                return this.frame("Citation", x, y, w, h, `<text:p>${runsXml(b.text)}</text:p>`)
            case "prompt":
            case "code": {
                const [pw] = promptSize(b.lines, w)
                return this.promptXml(b.lines, x + w - pw, y, pw, h, b.t === "prompt" ? "Prompt" : "Code")
            }
            case "table": {
                const pw = tablePartW(b, w)
                const cols = tableBlockCols(b, w)
                return tableParts(b)
                    .map((rows, i) =>
                        this.tableXml(b.header, rows, x + i * (pw + TABLE_GAP), y, pw, b.pt ?? sizes.table, false, cols, (r, c) => isHidden(b, r, c)),
                    )
                    .join("")
            }
            default:
                throw new Error(`Unexpected block ${b.t}`)
        }
    }

    // -- slide-level layout
    /** Return the required height and the shapes for the content blocks of one slide. */
    layout(blocks: Block[]): [number, string[]] {
        const imgs = blocks.filter(b => b.t === "image")
        const texts = blocks.filter(b => b.t !== "image")
        const shapes: string[] = []

        const sumH = (width: number) => texts.reduce((h, b) => h + blockH(b, width), 0) + GAP * (texts.length - 1)
        const stack = (bs: Block[], x: number, width: number, center = CENTER): number => {
            const top = center ? Y0 + Math.max(0, (H - sumH(width)) / 2) : Y0
            let y = top
            for (const b of bs) {
                const bh = blockH(b, width)
                shapes.push(this.blockXml(b, x, y, width, Math.min(bh, Math.max(Y0 + H - y, 1.5))))
                y += bh + GAP
            }
            return y - top - (bs.length ? GAP : 0)
        }

        if (!imgs.length) return [stack(texts, X0, W), shapes]
        const src = imgs[0].src
        const [iw, ih] = imageSize(resolve(this.base, src))
        if (!texts.length) {
            const [w, h] = fit(iw, ih, W, H)
            shapes.push(this.imageXml(src, X0 + (W - w) / 2, Y0 + (H - h) / 2, w, h))
            return [0, shapes]
        }
        if (iw / ih >= 1.8 || (iw / ih >= 1.2 && sumH(W) < 2.5)) {
            // The image below the text takes the free height.
            const th = stack(texts, X0, W, false)
            const avail = Math.max(H - th - GAP, 4.5)
            const [w, h] = fit(iw, ih, W, avail)
            shapes.push(this.imageXml(src, X0 + (W - w) / 2, Y0 + th + GAP + (avail - h) / 2, w, h))
            return [th + GAP + 4.5, shapes]
        }
        // Give the image more room when the text is short.
        const tw = W * (sumH(W * 0.42) < H * 0.6 ? 0.42 : 0.58)
        const th = stack(texts, X0, tw)
        const bw = W - tw - 0.8
        const [w, h] = fit(iw, ih, bw, H)
        shapes.push(this.imageXml(src, X0 + tw + 0.8 + (bw - w) / 2, Y0 + (H - h) / 2, w, h))
        return [th, shapes]
    }

    /** Split blocks into slides: list of [content blocks, notes]. */
    paginate(blocks: Block[]): [Block[], string[]][] {
        const slides: [Block[], string[]][] = [[[], []]]
        for (const b of blocks) {
            if (b.t === "note") {
                slides[slides.length - 1][1].push(b.text)
                continue
            }
            if (b.t === "table" && (!this.fits([b]) || ((b.compact || b.reveal) && !headerFits(b)))) {
                // A revealed table must stay on one slide: on two side-by-side tables, or else shrunk.
                if (b.reveal) this.twoColumns(b, slides) || this.compactTable(b, slides)
                else if (b.compact) this.compactTable(b, slides)
                else this.splitTable(b, slides)
                continue
            }
            const cur = slides[slides.length - 1][0]
            const hasImg = cur.some(x => x.t === "image")
            if (cur.length && ((b.t === "image" && hasImg) || !this.fits([...cur, b]))) {
                slides.push([[...this.carry(cur, b), b], []])
            } else {
                cur.push(b)
            }
        }
        return slides.filter(([c, n]) => c.length || n.length)
    }

    /** Do these blocks fit on one slide? */
    fits(blocks: Block[]): boolean {
        // `layout()` registers the automatic styles of the shapes it builds: forget those of this trial.
        const saved = [new Map(this.colStyles), new Map(this.rowStyles), new Map(this.paraStyles)]
        const ok = this.layout(blocks)[0] <= H
        ;[this.colStyles, this.rowStyles, this.paraStyles] = saved
        return ok
    }

    /**
     * Keep an introductory paragraph with the block `next` that starts a new slide:
     * the last paragraph of `cur`, removed from it, if it fits with `next`.
     */
    carry(cur: Block[], next: Block): Block[] {
        const last = cur[cur.length - 1]
        return cur.length > 1 && last.t === "para" && this.fits([last, next]) ? [cur.pop()!] : []
    }

    /**
     * A `@compact` table too long for one slide: its text is shrunk (by steps of half a point)
     * until it fits on a slide with the paragraph introducing it, if any. It stays on the current
     * slide if it fits there at that size, otherwise it starts a new one with its introduction.
     */
    compactTable(b: TableBlock, slides: [Block[], string[]][]) {
        const MIN_PT = 4
        const cur = slides[slides.length - 1][0]
        const last = cur[cur.length - 1]
        const intro = last?.t === "para" ? [last] : []
        const shrink = (t: TableBlock): TableBlock => {
            let small: TableBlock = t
            for (let pt = sizes.table - 0.5; pt >= MIN_PT; pt -= 0.5) {
                small = { ...t, pt }
                if (this.fits([...intro, small]) && headerFits(small)) break
            }
            return small
        }
        let small = shrink(b)
        // A revealed table can also be spread over two side-by-side tables, if its text stays bigger.
        if (b.reveal && b.rows.length > 1) {
            const two = shrink({ ...b, columns: 2 })
            const ok = (t: TableBlock) => this.fits([t]) && headerFits(t)
            if ((two.pt ?? sizes.table) > (small.pt ?? sizes.table) || !ok(small)) small = two
        }
        const pragma = b.reveal ? "@reveal" : "@compact"
        if (!this.fits([small])) console.warn(`  ! a ${pragma} table is still too long at ${MIN_PT}pt: it overflows its slide`)
        else if (!headerFits(small)) console.warn(`  ! a ${pragma} table still has header words too long for their column at ${MIN_PT}pt`)
        if (!cur.length || this.fits([...cur, small])) return void cur.push(small)
        const carry = cur.length > 1 && intro.length && this.fits([...intro, small]) ? [cur.pop()!] : []
        slides.push([[...carry, small], []])
    }

    /**
     * Spread the rows of a table over two side-by-side tables, if they fit on one slide: on the
     * current slide if there is room, otherwise on a new one. Return false if they do not fit.
     */
    twoColumns(b: TableBlock, slides: [Block[], string[]][]): boolean {
        if (b.rows.length < 2) return false
        const cur = slides[slides.length - 1][0]
        const two: TableBlock = { ...b, columns: 2 }
        // Narrower columns must not cut the words of the header of a `@compact` or `@reveal` table.
        if ((b.compact || b.reveal) && !headerFits(two)) return false
        if (cur.length && this.fits([...cur, two])) cur.push(two)
        else if (!this.fits([two])) return false
        else if (!cur.length) cur.push(two)
        else slides.push([[...this.carry(cur, two), two], []])
        return true
    }

    /**
     * A table too long for one slide: its rows are spread over two side-by-side tables if they fit
     * on one slide, otherwise over several slides. The header is repeated on each part.
     */
    splitTable(b: TableBlock, slides: [Block[], string[]][]) {
        if (this.twoColumns(b, slides)) return
        const cur = () => slides[slides.length - 1][0]
        const ref = b.rows
        let rest = b.rows
        while (rest.length) {
            const part = (k: number): TableBlock => ({ ...b, rows: rest.slice(0, k), ref })
            const c = cur()
            let k = 0
            while (k < rest.length && this.fits([...c, part(k + 1)])) k++
            if (!k && c.length) {
                // Not even one row fits under the current content: start on a new slide.
                const last = c[c.length - 1]
                slides.push([c.length > 1 && last.t === "para" ? [c.pop()!] : [], []])
                continue
            }
            // A single row taller than the slide still has to go somewhere.
            k = Math.max(k, 1)
            c.push(part(k))
            rest = rest.slice(k)
            if (rest.length) slides.push([[], []])
        }
    }

    // -- pages
    page(master: string, shapes: string[], notes: string[] = []) {
        this.pages.push({ master, shapes, notes })
    }

    titleShapes(title: string, crumbs: string[]): string[] {
        const out: string[] = []
        if (crumbs.length) out.push(this.frame("Fil-ariane", X0, 0.35, W, 0.6, `<text:p>${xmlText(crumbs.join(" › "))}</text:p>`))
        out.push(this.frame("Master-title", X0, 0.95, W, 1.6, `<text:p>${xmlText(title)}</text:p>`, "title", this.takeHints()))
        return out
    }

    sectionPage(sec: Section) {
        // The big title is always the top-level (`#`) heading; deeper headings go in the subtitle.
        const [title, ...rest] = sec.path()
        const shapes = [this.frame("Section-title", 2, 5, 24, 3.5, `<text:p>${xmlText(title)}</text:p>`, "title", this.takeHints())]
        if (rest.length)
            shapes.push(this.frame("Section-subtitle", 2, 8.8, 24, 1.5, `<text:p>${xmlText(rest.join(" › "))}</text:p>`, "subtitle"))
        const notes = sec.blocks.flatMap(b => (b.t === "note" ? [b.text] : []))
        this.page("Section", shapes, notes)
    }

    contentPages(title: string, crumbs: string[], blocks: Block[]) {
        // Notes not attached to a slide yet: they go to the next one.
        const pending: string[] = []
        let run: Block[] = []
        const flush = () => {
            for (const [content, notes] of this.paginate(run)) {
                if (!content.length) {
                    pending.push(...notes)
                    continue
                }
                const allNotes = [...pending.splice(0), ...notes]
                for (const step of revealSteps(content)) {
                    const [, shapes] = this.layout(step)
                    this.page("Master", [...this.titleShapes(title, crumbs), ...shapes], [...allNotes])
                }
            }
            run = []
        }
        // An `@layout` of blocks gets its own slide, between the slides of the blocks around it.
        for (const b of blocks) {
            if (b.t !== "layout") run.push(b)
            else if (b.cells.length) {
                flush()
                this.layoutPage(title, crumbs, b.cells, b.layout, pending.splice(0))
            }
        }
        flush()
        if (pending.length) this.pages[this.pages.length - 1].notes.push(...pending)
    }

    /** Height of a group of paragraphs/lists rendered at `pt` points. */
    static textGroupH(blocks: Block[], width: number, pt: number): number {
        let h = 0.4
        for (const b of blocks) {
            if (b.t === "para" || b.t === "quote") h += b.text.split("\n").reduce((a, p) => a + textH(plainLen(p), width - 0.6, pt), 0) + 0.15
            else if (b.t === "list") for (const [lvl, txt] of b.items) h += textH(plainLen(txt), width - 0.6 - 0.9 * (lvl + 1), pt) + 0.12
        }
        return h
    }

    /** Preferred width of a cell content, used by `auto` columns. */
    static preferredWidth(sec: Section, height: number, textPt: number): number {
        const cw = (pt: number) => pt * PT * 0.5
        let w = sec.title.length * cw(sizes.gridTitle) + 0.8
        for (const b of sec.blocks) {
            if (b.t === "para" || b.t === "quote") w = Math.max(w, plainLen(b.text) * cw(textPt) + 0.8)
            else if (b.t === "list") w = Math.max(w, ...b.items.map(([lvl, txt]) => plainLen(txt) * cw(textPt) + 0.9 * (lvl + 1) + 0.8))
            else if (b.t === "table") {
                const all = b.header ? [b.header, ...b.rows] : b.rows
                const ncol = Math.max(...all.map(r => r.length))
                let tw = 0
                for (let c = 0; c < ncol; c++) tw += Math.max(...all.map(r => Math.min(plainLen(cell(r[c] ?? "").text), 30))) * cw(sizes.tableSmall) + 0.6
                w = Math.max(w, tw)
            } else if (b.t === "image") {
                const [iw, ih] = imageSize(resolve(sec.source, b.src))
                w = Math.max(w, (iw / ih) * (height - 0.9))
            } else if (b.t === "prompt" || b.t === "code") w = Math.max(w, promptSize(b.lines, W)[0])
        }
        return w
    }

    /** Content of a section inside a cell of a grouped slide. */
    cellXml(sec: Section, x: number, y: number, w: number, h: number, textStyle: string, textPt: number): string[] {
        // Consecutive paragraphs and lists share one text frame.
        type Item = { kind: "text"; blocks: Block[] } | { kind: "block"; block: Block }
        const items: Item[] = []
        for (const b of sec.blocks) {
            if (b.t === "note" || b.t === "layout") continue
            const last = items[items.length - 1]
            if (b.t === "para" || b.t === "list" || b.t === "quote") {
                if (last?.kind === "text") last.blocks.push(b)
                else items.push({ kind: "text", blocks: [b] })
            } else items.push({ kind: "block", block: b })
        }
        const gap = 0.2
        const natural = items.map(it => {
            if (it.kind === "text") return Builder.textGroupH(it.blocks, w, textPt)
            const b = it.block
            if (b.t === "table") return tableH(b.header, b.rows, w, sizes.tableSmall)
            if (b.t === "prompt" || b.t === "code") return promptSize(b.lines, w)[1]
            return 0
        })
        const flexible = items.map(it => it.kind === "text" || (it.kind === "block" && it.block.t === "image"))
        const fixedH = natural.reduce((a, n, i) => a + (flexible[i] ? 0 : n), 0) + gap * Math.max(0, items.length - 1)
        const rem = Math.max(h - fixedH, 1.5)
        const heights = [...natural]
        const images = items.filter(it => it.kind === "block" && it.block.t === "image").length
        const textTotal = natural.reduce((a, n, i) => a + (flexible[i] ? n : 0), 0)
        if (images) {
            const left = Math.max(rem - textTotal, 2 * images)
            items.forEach((it, i) => {
                if (it.kind === "block" && it.block.t === "image") heights[i] = left / images
                else if (it.kind === "text") heights[i] = Math.min(natural[i], (natural[i] / Math.max(textTotal, 0.01)) * (rem - left))
            })
        } else if (textTotal > rem) {
            items.forEach((it, i) => {
                if (it.kind === "text") heights[i] = (natural[i] / textTotal) * rem
            })
        } else if (items[items.length - 1]?.kind === "text") {
            // A text frame ending the cell takes the free space, so its background fills the cell.
            heights[items.length - 1] += rem - textTotal
        }
        const shapes: string[] = []
        let cy = y
        items.forEach((it, i) => {
            const ih = Math.max(0.5, Math.min(heights[i], y + h - cy))
            if (it.kind === "text") {
                const inner = it.blocks
                    .map(b => (b.t === "list" ? this.listXml(b.items, textStyle) : b.t === "para" || b.t === "quote" ? `<text:p>${runsXml(b.text)}</text:p>` : ""))
                    .join("")
                shapes.push(this.frame(textStyle, x, cy, w, ih, inner))
            } else {
                const b = it.block
                if (b.t === "table") {
                    const header = b.header?.map(stripMd) ?? null
                    shapes.push(this.tableXml(header, b.rows, x, cy, w, sizes.tableSmall, true))
                } else if (b.t === "image") {
                    const [iw, ihh] = imageSize(resolve(sec.source, b.src))
                    const [fw, fh] = fit(iw, ihh, w, ih)
                    shapes.push(this.imageXml(b.src, x + (w - fw) / 2, cy + (ih - fh) / 2, fw, fh))
                } else if (b.t === "prompt" || b.t === "code") {
                    const [pw] = promptSize(b.lines, w)
                    shapes.push(this.promptXml(b.lines, x + w - pw, cy, pw, ih, b.t === "prompt" ? "Prompt" : "Code"))
                }
            }
            cy += heights[i] + gap
        })
        return shapes
    }

    /** Sections laid out on a single slide, following an `@layout` pragma. */
    layoutPage(title: string, crumbs: string[], group: Section[], layout: Layout, notes: string[]) {
        const shapes = this.titleShapes(title, crumbs)
        const headH = 0.9
        let cells: { x: number; y: number; w: number; h: number }[]
        if (layout.kind === "grid") {
            const gx = 0.5
            const gy = 0.4
            const cw = (W - gx * (layout.columns - 1)) / layout.columns
            const ch = (H - gy * (layout.rows - 1)) / layout.rows
            cells = group.map((_, n) => ({
                x: X0 + (n % layout.columns) * (cw + gx),
                y: Y0 + Math.floor(n / layout.columns) * (ch + gy),
                w: cw,
                h: ch,
            }))
        } else {
            const gx = 0.4
            const free = W - gx * (layout.widths.length - 1)
            const widths = layout.widths.map((spec, i) =>
                spec === "auto" && group[i] ? Builder.preferredWidth(group[i], H, sizes.columnText) : 0,
            )
            // Auto columns get their preferred width, but leave room for the fractions.
            const fractions = layout.widths.reduce((a: number, s) => a + (s === "auto" ? 0 : s), 0)
            const autoTotal = widths.reduce((a, b) => a + b, 0)
            const maxAuto = fractions ? free * 0.5 : free
            const scale = autoTotal > maxAuto ? maxAuto / autoTotal : 1
            const rest = free - autoTotal * scale
            layout.widths.forEach((spec, i) => {
                widths[i] = spec === "auto" ? widths[i] * scale : (rest * spec) / fractions
            })
            if (!fractions && autoTotal < free) {
                const extra = (free - autoTotal) / widths.length
                widths.forEach((_, i) => (widths[i] += extra))
            }
            let x = X0
            cells = widths.map(w => {
                const cell = { x, y: Y0, w, h: H }
                x += w + gx
                return cell
            })
        }
        const colors = style.theme.colors.grid.length
        group.forEach((sec, n) => {
            const { x, y, w, h } = cells[n]
            const [headStyle, textStyle, textPt] =
                layout.kind === "grid"
                    ? [`Grille-titre-${(n % colors) + 1}`, `Grille-texte-${(n % colors) + 1}`, sizes.gridText]
                    : ["Colonne-titre", "Colonne-texte", sizes.columnText]
            // Cells of an `@layout` of blocks have no heading.
            const hh = sec.title ? headH : 0
            if (sec.title) shapes.push(this.frame(headStyle, x, y, w, hh, `<text:p>${xmlText(sec.title)}</text:p>`))
            shapes.push(...this.cellXml(sec, x, y + hh, w, h - hh, textStyle, textPt))
            notes.push(...sec.blocks.flatMap(b => (b.t === "note" ? [b.text] : [])))
        })
        this.page("Master", shapes, notes)
    }

    walk(sec: Section) {
        this.pendingHints.push(...sec.hints)
        const crumbs = sec.path().slice(0, -1)
        const content = sec.blocks.filter(b => b.t !== "note")
        // A section whose only content is a grouped slide does not get its own divider slide.
        const groupedOnly = !content.length && sec.children[0]?.layout != null
        if (sec.level === 1 && !sec.continued) {
            this.sectionPage(sec)
            if (content.length) this.contentPages(sec.title, [...crumbs, sec.title], sec.blocks)
        } else if (content.length) {
            this.contentPages(sec.title, crumbs, sec.blocks)
        } else if (sec.children.length && !groupedOnly) {
            this.sectionPage(sec)
        }
        const notes = groupedOnly && sec.level > 1 ? sec.blocks.flatMap(b => (b.t === "note" ? [b.text] : [])) : []
        this.walkChildren(sec, notes)
    }

    walkChildren(sec: Section, notes: string[] = []) {
        const children = sec.children
        for (let i = 0; i < children.length; i++) {
            const layout = children[i].layout
            if (!layout) {
                this.walk(children[i])
                continue
            }
            const group = children.slice(i, i + cellCount(layout))
            for (const g of group) this.pendingHints.push(...g.hints)
            const title = sec.level > 0 ? sec.title : group[0].title
            this.layoutPage(title, sec.path().slice(0, -1), group, layout, i === 0 ? notes : [])
            // Sub-sections of grouped sections still get their own slides.
            for (const g of group) this.walkChildren(g)
            i += group.length - 1
        }
    }
}

// ---------------------------------------------------------------- XML documents

const NS = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
    'xmlns:xlink="http://www.w3.org/1999/xlink"',
    'xmlns:dc="http://purl.org/dc/elements/1.1/"',
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
    'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"',
    'office:version="1.3"',
].join(" ")

function attrs(props: Props = {}, where = ""): string {
    return Object.entries(props)
        .map(([k, v]) => `${k}="${esc(resolveValue(String(v), where))}"`)
        .join(" ")
}

function bulletsXml(def: BulletDef, name: string): string {
    const color = esc(resolveValue(def.color, `bullets of style "${name}"`))
    const size = esc(resolveValue(def.size, `bullets of style "${name}"`))
    const levels = def.chars.map(
        (char, i) =>
            `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="${esc(char)}">` +
            `<style:list-level-properties text:space-before="${f2(def.indent * i)}cm" text:min-label-width="0.8cm"/>` +
            `<style:text-properties fo:font-family="OpenSymbol" style:use-window-font-color="false" fo:color="${color}" fo:font-size="${size}"/>` +
            `</text:list-level-style-bullet>`,
    )
    return `<text:list-style style:name="${esc(name)}-list">${levels.join("")}</text:list-style>`
}

/** `name` or its nearest parent style defining both `bullets` and `numbers`, if any. */
function listStyleHolder(name: string): string | null {
    for (let n: string | undefined = name, depth = 0; n && depth < 20; depth++) {
        const s: StyleDef | undefined = style.styles[n]
        if (s?.bullets && s.numbers) return n
        n = s?.parent
    }
    return null
}

/** Level of a numbered list style: `1.`, `a.`, `i.`... */
function numbersXml(def: NumberDef, name: string): string {
    const where = `numbers of style "${name}"`
    const levels = def.formats.map(
        (format, i) =>
            `<text:list-level-style-number text:level="${i + 1}" style:num-format="${esc(format)}" style:num-suffix="${esc(def.suffix)}">` +
            `<style:list-level-properties text:space-before="${f2(def.indent * i)}cm" text:min-label-width="${f2(def.width)}cm"/>` +
            `<style:text-properties style:use-window-font-color="false" fo:color="${esc(resolveValue(def.color, where))}" ` +
            `fo:font-size="${esc(resolveValue(def.size, where))}" fo:font-weight="${esc(resolveValue(def.weight, where))}"/>` +
            `</text:list-level-style-number>`,
    )
    return `<text:list-style style:name="${esc(name)}-numbers">${levels.join("")}</text:list-style>`
}

/**
 * Named list styles `<name>-bullets` and `<name>-numbers` of a style holding numbered lists:
 * lists mixing bullets and numbers name them explicitly (see `Builder.listXml()`).
 */
function listStylesXml(name: string, s: StyleDef): string {
    if (!s.bullets || !s.numbers) return ""
    return bulletsXml(s.bullets, name).replace(`style:name="${esc(name)}-list"`, `style:name="${esc(name)}-bullets"`) + numbersXml(s.numbers, name)
}

function styleXml(name: string, s: StyleDef): string {
    const parent = s.parent ? ` style:parent-style-name="${esc(s.parent)}"` : ""
    const list = s.bullets ? bulletsXml(s.bullets, name) : ""
    const where = `style "${name}"`
    return (
        `<style:style style:name="${esc(name)}" style:family="${s.family}"${parent}>` +
        `<style:graphic-properties ${attrs(s.graphic, where)}>${list}</style:graphic-properties>` +
        `<style:paragraph-properties ${attrs(s.paragraph, where)}/>` +
        `<style:text-properties ${attrs(s.text, where)}/></style:style>`
    )
}

const backgroundStyle = (master: string) => `M${master}-image`

/**
 * LibreOffice ignores image adjustments (`draw:image-opacity`, `draw:color-mode`...) inherited
 * from a named style, so the master images get an automatic style repeating them.
 */
function backgroundStyleXml(master: "Master" | "Section"): string {
    const name = `${master}-image`
    return (
        `<style:style style:name="${backgroundStyle(master)}" style:family="graphic" style:parent-style-name="${name}">` +
        `<style:graphic-properties ${attrs(style.styles[name]?.graphic, `style "${name}"`)}/></style:style>`
    )
}

/** Frame of the image of a master page (see `theme.backgrounds`), or "" if it has none. */
function backgroundXml(b: Builder, master: "Master" | "Section"): string {
    const bg: BackgroundImage = style.theme.backgrounds[master]
    if (!bg.image) return ""
    const { href, size } = b.picture(bg.image)
    let { x = 0, y = 0, width: w = SLIDE_W, height: h = SLIDE_H } = bg
    if (bg.fit === "contain") {
        const scale = Math.min(w / size[0], h / size[1])
        x += (w - size[0] * scale) / 2
        y += (h - size[1] * scale) / 2
        w = size[0] * scale
        h = size[1] * scale
    }
    return (
        `<draw:frame draw:style-name="${backgroundStyle(master)}" ${Builder.geom(x, y, w, h)}>` +
        `<draw:image xlink:href="${esc(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
        `</draw:frame>`
    )
}

function stylesXml(b: Builder): string {
    const templates = style.tableTemplates.map(
        t =>
            `<table:table-template table:name="${esc(t.name)}">` +
            `<table:first-row table:style-name="${esc(t.header)}"/>` +
            `<table:body table:style-name="${esc(t.body)}"/>` +
            `<table:odd-rows table:style-name="${esc(t.bandedRows)}"/>` +
            `</table:table-template>`,
    )
    const markers = [
        ...Object.entries(style.markers).map(
            ([name, m]) => `<draw:marker draw:name="${esc(name)}" svg:viewBox="${esc(m.viewBox)}" svg:d="${esc(m.d)}"/>`,
        ),
        ...Object.entries(style.dashes).map(([name, props]) => `<draw:stroke-dash draw:name="${esc(name)}" ${attrs(props)}/>`),
    ]
    const auto = [
        `<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${SLIDE_W}cm" fo:page-height="${SLIDE_H}cm" style:print-orientation="landscape"/></style:page-layout>`,
        `<style:page-layout style:name="PM2"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait"/></style:page-layout>`,
        `<style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:background-size="full" draw:fill="solid" draw:fill-color="#FFFFFF"/></style:style>`,
        backgroundStyleXml("Master"),
        backgroundStyleXml("Section"),
    ]
    const notes = (m: string) =>
        `<presentation:notes style:page-layout-name="PM2">` +
        `<draw:page-thumbnail presentation:style-name="${m}-title" presentation:class="page" svg:x="1.5cm" svg:y="1.5cm" svg:width="18cm" svg:height="10.13cm"/>` +
        `<draw:frame presentation:style-name="${m}-notes" presentation:class="notes" presentation:placeholder="true" svg:x="1.5cm" svg:y="12.5cm" svg:width="18cm" svg:height="15cm"><draw:text-box/></draw:frame>` +
        `</presentation:notes>`
    const placeholder = (styleName: string, cls: string, x: number, y: number, w: number, h: number) =>
        `<draw:frame presentation:style-name="${styleName}" presentation:class="${cls}" presentation:placeholder="true" ${Builder.geom(x, y, w, h)}><draw:text-box/></draw:frame>`
    const masters = [
        `<style:master-page style:name="Master" style:page-layout-name="PM1" draw:style-name="Mdp1">` +
            backgroundXml(b, "Master") +
            `<draw:rect draw:style-name="Decor" ${Builder.geom(0, 0, 0.4, SLIDE_H)}/>` +
            `<draw:line draw:style-name="Decor-ligne" svg:x1="${X0}cm" svg:y1="2.7cm" svg:x2="${X0 + W}cm" svg:y2="2.7cm"/>` +
            placeholder("Master-title", "title", X0, 0.95, W, 1.6) +
            placeholder("Master-outline1", "outline", X0, Y0, W, H) +
            `${notes("Master")}</style:master-page>`,
        `<style:master-page style:name="Section" style:page-layout-name="PM1" draw:style-name="Mdp1">` +
            `<draw:rect draw:style-name="Section-fond" ${Builder.geom(0, 0, SLIDE_W, SLIDE_H)}/>` +
            backgroundXml(b, "Section") +
            `<draw:rect draw:style-name="Decor" ${Builder.geom(0, 8.55, SLIDE_W, 0.12)}/>` +
            placeholder("Section-title", "title", 2, 5, 24, 3.5) +
            placeholder("Section-subtitle", "subtitle", 2, 8.8, 24, 1.5) +
            `${notes("Section")}</style:master-page>`,
    ]
    return (
        `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}>` +
        `<office:styles>${Object.entries(style.styles).map(([name, s]) => styleXml(name, s)).join("")}${templates.join("")}${markers.join("")}</office:styles>` +
        `<office:automatic-styles>${auto.join("")}</office:automatic-styles>` +
        `<office:master-styles>${masters.join("")}</office:master-styles></office:document-styles>`
    )
}

function contentXml(b: Builder): string {
    const auto = Object.entries(style.spanStyles).map(
        ([name, props]) =>
            `<style:style style:name="${esc(name)}" style:family="text"><style:text-properties ${attrs(props, `span style "${name}"`)}/></style:style>`,
    )
    // Impress only finds the list styles named by `<text:list>` among the automatic styles.
    for (const [name, s] of Object.entries(style.styles)) auto.push(listStylesXml(name, s))
    for (const [key, name] of b.colStyles)
        auto.push(`<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${key}cm"/></style:style>`)
    for (const [key, name] of b.paraStyles) {
        const [pt, indent] = key.split("/")
        const para = indent ? `<style:paragraph-properties fo:margin-left="${indent}cm"/>` : ""
        auto.push(`<style:style style:name="${name}" style:family="paragraph">${para}<style:text-properties fo:font-size="${pt}pt"/></style:style>`)
    }
    for (const [key, name] of b.rowStyles)
        auto.push(`<style:style style:name="${name}" style:family="table-row"><style:table-row-properties style:row-height="${key}cm"/></style:style>`)
    const pages = b.pages.map(({ master, shapes, notes }, i) => {
        const n = i + 1
        const noteXml = notes.map(t => `<text:p>${xmlText(t)}</text:p>`).join("")
        return (
            `<draw:page draw:name="page${n}" draw:master-page-name="${master}">${shapes.join("")}` +
            `<presentation:notes><draw:page-thumbnail presentation:style-name="${master}-title" presentation:class="page" draw:page-number="${n}" svg:x="1.5cm" svg:y="1.5cm" svg:width="18cm" svg:height="10.13cm"/>` +
            `<draw:frame presentation:style-name="${master}-notes" presentation:class="notes" svg:x="1.5cm" svg:y="12.5cm" svg:width="18cm" svg:height="15cm"><draw:text-box>${noteXml}</draw:text-box></draw:frame>` +
            `</presentation:notes></draw:page>`
        )
    })
    return (
        `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>` +
        `<office:automatic-styles>${auto.join("")}</office:automatic-styles>` +
        `<office:body><office:presentation>${pages.join("")}</office:presentation></office:body></office:document-content>`
    )
}

// ---------------------------------------------------------------- ZIP

/** Minimal ZIP writer: enough for ODF packages. */
function zip(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const { name, data, store } of entries) {
        const nameBuf = Buffer.from(name, "utf8")
        const body = store ? data : deflateRawSync(data)
        const crc = crc32(data)
        const method = store ? 0 : 8
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x0800, 6) // UTF-8 names
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0x21, 12) // 1980-01-01
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(body.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28)
        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(method, 10)
        central.writeUInt16LE(0, 12)
        central.writeUInt16LE(0x21, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(body.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(nameBuf.length, 28)
        central.writeUInt32LE(offset, 42)
        locals.push(local, nameBuf, body)
        centrals.push(central, nameBuf)
        offset += local.length + nameBuf.length + body.length
    }
    const cd = Buffer.concat(centrals)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(cd.length, 12)
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, cd, end])
}

async function writeOdp(b: Builder, out: string, title: string) {
    // Before listing the pictures: the master pages can add some.
    const styles = stylesXml(b)
    const content = contentXml(b)
    const pics = [...b.pictures.values()]
    await encodePictures(pics)
    const manifest =
        '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
        pics.map(p => `<manifest:file-entry manifest:full-path="${esc(p.href)}" manifest:media-type="${MIME[extname(p.href).toLowerCase()]}"/>`).join("") +
        "</manifest:manifest>"
    const meta =
        `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta>` +
        `<dc:title>${esc(title)}</dc:title><meta:generator>impress.ts</meta:generator></office:meta></office:document-meta>`
    const text = (s: string) => Buffer.from(s, "utf8")
    writeFileSync(
        out,
        zip([
            { name: "mimetype", data: text("application/vnd.oasis.opendocument.presentation"), store: true },
            { name: "META-INF/manifest.xml", data: text(manifest) },
            { name: "meta.xml", data: text(meta) },
            { name: "styles.xml", data: text(styles) },
            { name: "content.xml", data: text(content) },
            ...pics.map(p => ({ name: p.href, data: p.data, store: true })),
        ]),
    )
}

// ---------------------------------------------------------------- main

function humanSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"]
    let n = bytes
    let u = 0
    while (n >= 1024 && u < units.length - 1) {
        n /= 1024
        u++
    }
    return `${u ? n.toFixed(1) : n} ${units[u]}`
}

function countHints(sec: Section): number {
    return sec.hints.length + sec.children.reduce((n, c) => n + countHints(c), 0)
}

async function convert(src: string, config: StyleConfig): Promise<{ out: string; hints: number }> {
    useStyle(config)
    const root = parse(readFileSync(src, "utf8"), src)
    const b = new Builder(dirname(src))
    b.walkChildren(root)
    const out = src.replace(/\.md$/i, ".odp")
    await writeOdp(b, out, basename(src, extname(src)))
    return { out, hints: countHints(root) }
}

/** A ready-to-paste prompt asking an AI agent to apply the `@hint` pragmas of the given presentations. */
function aiPrompt(files: string[]): string {
    const rule = "-".repeat(72)
    return [
        rule,
        `Refine ${files.length > 1 ? "these LibreOffice Impress presentations" : "this LibreOffice Impress presentation"}:`,
        ...files.map(f => `  - ${bold(f)}`),
        "",
        "An .odp file is a ZIP archive. In its content.xml, some slide titles carry",
        "layout instructions in their alt-text description: <svg:desc> elements whose",
        "lines start with \"@hint\". Each hint describes how its slide (and the following",
        "slides of the same section) should be transformed.",
        "",
        "For each hint:",
        "  1. Find the slide(s) it applies to and apply the requested change",
        "     (layout, splitting or merging slides, animations, ...).",
        "  2. Reuse the existing styles from styles.xml (drawing, presentation and",
        "     table-cell styles) instead of adding direct formatting.",
        "  3. Keep the speaker notes and every <svg:desc> hint verbatim, so the",
        "     file can be refined again later.",
        "",
        "Rebuild each archive with \"mimetype\" as its first entry, stored uncompressed,",
        "and check that LibreOffice still opens it, e.g.:",
        "  soffice --headless --convert-to pdf <file>.odp",
        "Then summarize, hint by hint, what you changed.",
        rule,
    ].join("\n")
}

const PRAGMAS: [string, string][] = [
    ["@note <text>", "Speaker note of the current slide (seen by the teacher only)."],
    ["@note begin ... @note end", "Multi-line speaker note."],
    ["@hint <text>", "Instruction for an AI: stored verbatim in the .odp (alt-text of the slide title), never displayed."],
    ["@layout grid <C>x<R>", "Put the next C×R sections (starting at the next heading) on one slide, in a grid."],
    ["@layout columns <sizes>", 'Put the next sections on one slide, in columns sized "1fr", "2fr"... or "auto" (one size per section).'],
    ["@layout ... (no heading after)", "Put the next blocks (paragraph, list, image...) of the section on one slide, one per cell, without headings."],
    ["@graph <file.dot>", "Insert a Graphviz diagram (path relative to the .md), rendered as a PNG image by dot."],
    ["@next", "Start a new slide with the same title as the current one (unless a heading follows)."],
    ["@compact", "Shrink the next table so that it fits on one slide, instead of splitting it."],
    ["@reveal [C<cols>] [R<rows>]", 'Reveal the rows of the next table one slide after the other; "C1,3 R1-4" keeps columns 1 and 3 and rows 1 to 4 always visible.'],
    ["```prompt ... ```", "Not a pragma: a code block shown as a chat prompt bubble."],
]

function printHelp() {
    console.log(
        [
            "Convert markdown files into LibreOffice Impress presentations.",
            "",
            "Usage: node scripts/impress/impress.ts <file.md> [<file.md> ...]",
            "",
            "Each foo.md produces foo.odp in the same folder. Headings become section and",
            "content slides. The styles come from foo.style.json, created with the default",
            "styles if missing (edit it, then run again to restyle the presentation).",
        ].join("\n"),
    )
    console.log("\nPragmas (at the start of a line in the .md file):")
    const width = Math.max(...PRAGMAS.map(([p]) => p.length))
    for (const [pragma, text] of PRAGMAS) console.log(`  ${pragma.padEnd(width)}  ${text}`)
}

async function main(args: string[]) {
    if (!args.length) {
        printHelp()
        return
    }
    const files = args.filter(f => f.toLowerCase().endsWith(".md"))
    for (const f of args) if (!files.includes(f)) console.warn(`Ignoring ${bold(f)}: not a .md file`)
    if (!files.length) {
        console.error("No .md file given. Run without arguments for help.")
        process.exit(1)
    }
    const withHints: [string, number][] = []
    let failed = false
    for (const file of files) {
        const src = resolve(file)
        console.log(`Processing ${bold(src)}`)
        try {
            if (existsSync(src) && usesGraph(src)) await ensureDot()
            const { config, path, created } = loadStyle(src)
            console.log(created ? `  + ${bold(path)} (created with the default style)` : `  ⚙ ${bold(path)}`)
            const { out, hints } = await convert(src, config)
            console.log(`  → ${bold(out)} (${humanSize(statSync(out).size)})`)
            if (hints) withHints.push([out, hints])
        } catch (err) {
            failed = true
            console.error(`  ✗ ${err instanceof Error ? err.message : err}`)
        }
    }
    if (withHints.length) {
        console.log("\nThese presentations contain @hint pragmas (stored in the slide titles' alt-text descriptions)")
        console.log("and can be refined with AI:")
        for (const [out, n] of withHints) console.log(`  - ${bold(out)} (${n} hint${n > 1 ? "s" : ""})`)
        console.log("\nExample of prompt to give to an AI agent able to read and write files:\n")
        console.log(cyan(aiPrompt(withHints.map(([out]) => out))))
    }
    if (failed) process.exit(1)
}

await main(process.argv.slice(2))
