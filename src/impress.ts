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
 *   @graph diagram.dot      Graphviz diagram converted into native, editable shapes
 *   ```prompt ... ```       chat prompt bubble
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { basename, dirname, extname, resolve } from "node:path"
import { crc32, deflateRawSync } from "node:zlib"
import type { Graphviz } from "@hpcc-js/wasm-graphviz"

import { defaultStyle, type BulletDef, type Props, type StyleConfig, type StyleDef } from "./styles.ts"

const PT = 0.03528 // cm per point

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

function useStyle(config: StyleConfig) {
    style = config
    sizes = config.theme.sizes
    SLIDE_W = config.theme.slide.width
    SLIDE_H = config.theme.slide.height
    ;({ x: X0, y: Y0, width: W, height: H, gap: GAP } = config.theme.content)
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

type Block =
    | { t: "para"; text: string }
    | { t: "list"; items: [number, string][] }
    | { t: "quote"; text: string }
    | { t: "prompt" | "code"; lines: string[] }
    | { t: "table"; header: string[] | null; rows: string[][] }
    | { t: "image"; alt: string; src: string }
    | { t: "note"; text: string }

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

const LIST_RE = /^(\s*)[*-]\s+(.*)$/
const IMG_RE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/
const HEAD_RE = /^(#{1,6})\s+(.*)$/

function parse(md: string, file: string): Section {
    const root = new Section(0, "", null, dirname(file))
    let cur = root
    const lines = md.split("\n")
    let para: string[] = []
    let list: { t: "list"; items: [number, string][] } | null = null
    let layout: Layout | null = null

    const flushPara = () => {
        if (!para.length) return
        let text = ""
        para.forEach((l, j) => {
            text += l.trim()
            if (j < para.length - 1) text += l.endsWith("  ") ? "\n" : " "
        })
        cur.blocks.push({ t: "para", text })
        para = []
    }
    const flushList = () => {
        if (list) cur.blocks.push(list)
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
            const level = m[1].length
            while (cur.level >= level) cur = cur.parent!
            const sec = new Section(level, stripMd(m[2]), cur, root.source)
            sec.layout = layout
            layout = null
            cur.children.push(sec)
            cur = sec
        } else if (s.startsWith("@layout")) {
            flush()
            layout = parseLayout(s.slice(7).trim(), `${file}:${i + 1}`)
        } else if (s.startsWith("@graph")) {
            flush()
            const src = s.slice(6).trim()
            const where = `${file}:${i + 1}`
            if (!src.toLowerCase().endsWith(".dot")) throw new Error(`${where}: expected "@graph <relative path of a .dot file>", got "${s}"`)
            if (!existsSync(resolve(dirname(file), src))) throw new Error(`${where}: file not found: ${src}`)
            cur.blocks.push({ t: "image", alt: "", src })
        } else if (s.startsWith("@hint")) {
            flush()
            cur.hints.push(s)
        } else if (s === "@note begin") {
            flush()
            const buf: string[] = []
            for (i++; i < lines.length && lines[i].trim() !== "@note end"; i++) buf.push(lines[i])
            cur.blocks.push({ t: "note", text: buf.join("\n").trim() })
        } else if (s.startsWith("@note")) {
            flush()
            cur.blocks.push({ t: "note", text: s.slice(5).trim() })
        } else if (s.startsWith("```")) {
            flush()
            const lang = s.slice(3).trim()
            const buf: string[] = []
            for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) buf.push(lines[i])
            cur.blocks.push({ t: lang === "prompt" ? "prompt" : "code", lines: buf })
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
            cur.blocks.push({ t: "table", header, rows: body })
        } else if (s.startsWith(">")) {
            flush()
            const buf: string[] = []
            for (; i < lines.length && lines[i].trim().startsWith(">"); i++) buf.push(lines[i].trim().slice(1).trim())
            i--
            cur.blocks.push({ t: "quote", text: buf.join(" ") })
        } else if ((m = line.match(IMG_RE))) {
            flush()
            cur.blocks.push({ t: "image", alt: m[1], src: m[2] })
        } else if ((m = line.match(LIST_RE))) {
            flushPara()
            list ??= { t: "list", items: [] }
            list.items.push([Math.floor(m[1].length / 2), m[2].trim()])
        } else if (s === "") {
            flushPara()
            // A blank line ends a list unless the next non-blank line is a list item.
            let j = i + 1
            while (j < lines.length && lines[j].trim() === "") j++
            if (list && !(j < lines.length && LIST_RE.test(lines[j]))) flushList()
        } else if (list && line.startsWith(" ")) {
            const items: [number, string][] = list.items
            items[items.length - 1][1] += " " + s
        } else {
            flushList()
            para.push(line)
        }
    }
    flush()
    if (layout) console.warn(`  ! ${file}: "${(layout as Layout).source}" is not followed by any section`)
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

function listH(items: [number, string][], width: number): number {
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

function tableCols(header: string[] | null, rows: string[][], width: number): number[] {
    const all = header ? [header, ...rows] : rows
    const ncol = Math.max(...all.map(r => r.length))
    const lens = new Array<number>(ncol).fill(0)
    for (const r of all) r.forEach((cell, c) => (lens[c] = Math.max(lens[c], Math.min(plainLen(cell), 45) + 4)))
    const tot = lens.reduce((a, b) => a + b, 0)
    return lens.map(l => (width * l) / tot)
}

function rowH(r: string[], cols: number[], pt: number): number {
    return Math.max(...r.map((c, i) => textH(plainLen(c), cols[i] - 0.4, pt))) + 0.35
}

function tableH(header: string[] | null, rows: string[][], width: number, pt: number, cols?: number[]): number {
    cols ??= tableCols(header, rows, width)
    return (header ? [header, ...rows] : rows).reduce((h, r) => h + rowH(r, cols, pt), 0)
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
            return tableH(b.header, b.rows, width, sizes.table)
        default:
            return 0
    }
}

function imageSize(path: string): [number, number] {
    const ext = extname(path).toLowerCase()
    if (ext === ".dot") return graphLayout(path).size
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

const CM_PER_POINT = 2.54 / 72

interface GvObject {
    _gvid: number
    name: string
    [attr: string]: unknown
}

interface GvEdge {
    tail: number
    head: number
    [attr: string]: unknown
}

interface GraphLayout {
    name: string
    directed: boolean
    /** Bounding box in points: x0, y0, x1, y1 (y axis pointing up). */
    bb: number[]
    /** Natural size in cm. */
    size: [number, number]
    objects: GvObject[]
    edges: GvEdge[]
    /** Graph attributes (label, lp, lwidth, fontsize, fontcolor...). */
    attrs: Record<string, unknown>
}

const graphCache = new Map<string, GraphLayout>()

/** Graphviz compiled to WebAssembly (`@hpcc-js/wasm-graphviz`), loaded by `loadGraphviz()`. */
let graphviz: Graphviz | null = null
let graphvizError = ""

async function loadGraphviz() {
    try {
        const lib = await import("@hpcc-js/wasm-graphviz")
        graphviz = await lib.Graphviz.load()
    } catch (err) {
        graphvizError = err instanceof Error ? err.message : String(err)
    }
}

/**
 * Lay out a .dot file with Graphviz, using the fonts of the current style.
 * The fonts are inserted as default attributes after the opening brace, so
 * attributes set in the .dot file still take precedence.
 */
function graphLayout(path: string): GraphLayout {
    if (!graphviz) throw new Error(`Graphviz is not available (run "pnpm install" in scripts/impress): ${graphvizError}`)
    const font = style.theme.fonts.sans.replace(/'/g, "")
    const defaults =
        `graph [fontname="${font}", fontsize=${sizes.graphEdgeText}]; ` +
        `node [fontname="${font}", fontsize=${sizes.graphText}]; ` +
        `edge [fontname="${font}", fontsize=${sizes.graphEdgeText}]; `
    const source = readFileSync(path, "utf8")
    const head = source.match(/\b(?:strict\s+)?(?:di)?graph\b[^{]*\{/i)
    if (!head || head.index === undefined) throw new Error(`${path}: no "graph { ... }" or "digraph { ... }" found`)
    const at = head.index + head[0].length
    const dot = source.slice(0, at) + defaults + source.slice(at)
    let layout = graphCache.get(dot)
    if (layout) return layout
    let json: string
    try {
        json = graphviz.layout(dot, "json", "dot")
    } catch (err) {
        throw new Error(`Graphviz failed on ${path}: ${err instanceof Error ? err.message : err}`)
    }
    const g = JSON.parse(json)
    const bb = String(g.bb ?? "0,0,0,0").split(",").map(Number)
    layout = {
        name: g.name ?? "",
        directed: g.directed !== false,
        bb,
        size: [Math.max(bb[2] - bb[0], 1) * CM_PER_POINT, Math.max(bb[3] - bb[1], 1) * CM_PER_POINT],
        objects: g.objects ?? [],
        edges: g.edges ?? [],
        attrs: g,
    }
    graphCache.set(dot, layout)
    return layout
}

/** Graphviz node shapes and their Impress preset geometry. */
const NODE_SHAPES: Record<string, string> = {
    box: "rectangle",
    rect: "rectangle",
    rectangle: "rectangle",
    square: "rectangle",
    record: "rectangle",
    Mrecord: "round-rectangle",
    ellipse: "ellipse",
    oval: "ellipse",
    circle: "ellipse",
    doublecircle: "ellipse",
    point: "ellipse",
    diamond: "diamond",
    Mdiamond: "diamond",
    parallelogram: "parallelogram",
    trapezium: "trapezoid",
    hexagon: "hexagon",
    octagon: "octagon",
    triangle: "isosceles-triangle",
    cylinder: "flowchart-magnetic-disk",
    note: "flowchart-document",
    folder: "flowchart-card",
    star: "star5",
}

const COLOR_NAMES: Record<string, string> = {
    black: "#000000",
    white: "#FFFFFF",
    red: "#FF0000",
    green: "#00A000",
    blue: "#0000FF",
    yellow: "#FFFF00",
    orange: "#FFA500",
    purple: "#800080",
    pink: "#FFC0CB",
    brown: "#A52A2A",
    gray: "#808080",
    grey: "#808080",
    lightgray: "#D3D3D3",
    lightgrey: "#D3D3D3",
    darkgray: "#A9A9A9",
    lightblue: "#ADD8E6",
    lightyellow: "#FFFFE0",
    lightgreen: "#90EE90",
    lightpink: "#FFB6C1",
    gold: "#FFD700",
    navy: "#000080",
    cyan: "#00FFFF",
    magenta: "#FF00FF",
    darkgreen: "#006400",
    darkblue: "#00008B",
    darkred: "#8B0000",
}

function gvColor(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null
    const v = value.split(":")[0].trim()
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase()
    if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7).toUpperCase()
    return COLOR_NAMES[v.toLowerCase()] ?? null
}

/** Text of a Graphviz label, with "\n" for line breaks. */
function gvLabel(raw: unknown, name: string, graphName: string, record = false): string {
    let label = typeof raw === "string" ? raw : "\\N"
    if (label.startsWith("<") && label.endsWith(">")) {
        label = label
            .slice(1, -1)
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
    }
    label = label.replaceAll("\\N", name).replaceAll("\\G", graphName)
    if (record) label = label.replace(/[{}]/g, "").replace(/\s*\|\s*/g, "\n")
    return label
        .replace(/\\[nlr]/g, "\n")
        .replace(/\n$/, "")
        .replace(/\\(.)/g, "$1")
}

/** Stroke properties for Graphviz `style=dashed` or `style=dotted`. */
function dashed(gvStyle: unknown): Props {
    const dash = Object.keys(style.dashes)[0]
    return dash && /\b(dashed|dotted)\b/.test(String(gvStyle ?? "")) ? { "draw:stroke": "dash", "draw:stroke-dash": dash } : {}
}

function gvPoint(s: string): [number, number] {
    const [x, y] = s.split(",").map(Number)
    return [x, y]
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
    data: Buffer
    size: [number, number]
}

type Page = { master: string; shapes: string[]; notes: string[] }

const f2 = (n: number) => n.toFixed(2)

class Builder {
    base: string
    pictures = new Map<string, Picture>()
    pages: Page[] = []
    colStyles = new Map<string, string>()
    rowStyles = new Map<string, string>()
    /** Hints waiting to be attached to the next slide title. */
    pendingHints: string[] = []
    /** Automatic graphic styles (Graphviz colors), keyed by their properties. */
    autoStyles = new Map<string, { name: string; parent: string; graphic: Props }>()
    /** Automatic paragraph styles (text size and color in diagrams). */
    paraStyles = new Map<string, { name: string; text: Props }>()
    graphCount = 0

    constructor(base: string) {
        this.base = base
    }

    // -- resources
    picture(src: string): Picture {
        let pic = this.pictures.get(src)
        if (!pic) {
            const path = resolve(this.base, src)
            let name = basename(src)
            while ([...this.pictures.values()].some(p => p.href === `Pictures/${name}`)) name = `_${name}`
            pic = { href: `Pictures/${name}`, data: readFileSync(path), size: imageSize(path) }
            this.pictures.set(src, pic)
        }
        return pic
    }

    colStyle(w: number): string {
        const key = f2(w)
        if (!this.colStyles.has(key)) this.colStyles.set(key, `co${this.colStyles.size + 1}`)
        return this.colStyles.get(key)!
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

    listXml(items: [number, string][]): string {
        const out: string[] = []
        let depth = 0
        for (const [lvl, txt] of items) {
            while (depth > lvl + 1) {
                out.push("</text:list-item></text:list>")
                depth--
            }
            if (depth === lvl + 1) out.push("</text:list-item><text:list-item>")
            while (depth < lvl + 1) {
                out.push("<text:list><text:list-item>")
                depth++
            }
            out.push(`<text:p>${runsXml(txt)}</text:p>`)
        }
        while (depth-- > 0) out.push("</text:list-item></text:list>")
        return out.join("")
    }

    tableXml(header: string[] | null, rows: string[][], x: number, y: number, width: number, pt: number, small = false, cols?: number[]): string {
        cols ??= tableCols(header, rows, width)
        const prefix = small ? "Tableau-petit" : "Tableau"
        const parts = [
            `<draw:frame draw:style-name="Tableau-cadre" ${Builder.geom(x, y, width, tableH(header, rows, width, pt, cols))}>`,
            `<table:table table:template-name="${prefix}" table:use-first-row-styles="${header ? "true" : "false"}" table:use-banding-rows-styles="true">`,
            ...cols.map(cw => `<table:table-column table:style-name="${this.colStyle(cw)}"/>`),
        ]
        const all: [string, string[]][] = [
            ...(header ? [["entete", header] as [string, string[]]] : []),
            ...rows.map((r, i): [string, string[]] => [i % 2 === 0 ? "cellule" : "cellule-alt", r]),
        ]
        for (const [kind, r] of all) {
            parts.push(`<table:table-row table:style-name="${this.rowStyle(rowH(r, cols, pt))}">`)
            cols.forEach((_, i) => {
                parts.push(`<table:table-cell table:style-name="${prefix}-${kind}"><text:p>${runsXml(r[i] ?? "")}</text:p></table:table-cell>`)
            })
            parts.push("</table:table-row>")
        }
        parts.push("</table:table></draw:frame>")
        return parts.join("")
    }

    imageXml(src: string, x: number, y: number, w: number, h: number): string {
        if (extname(src).toLowerCase() === ".dot") return this.graphXml(resolve(this.base, src), x, y, w, h)
        const { href } = this.picture(src)
        const mime = href.endsWith(".svg") ? ' draw:mime-type="image/svg+xml"' : ""
        return (
            `<draw:frame draw:style-name="Image" ${Builder.geom(x, y, w, h)}>` +
            `<draw:image xlink:href="${esc(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"${mime}/>` +
            `</draw:frame>`
        )
    }

    /** Automatic style deriving from a named style, for colors set in a .dot file. */
    autoStyle(parent: string, graphic: Props): string {
        if (!Object.keys(graphic).length) return parent
        const key = JSON.stringify([parent, graphic])
        let entry = this.autoStyles.get(key)
        if (!entry) {
            entry = { name: `gr${this.autoStyles.size + 1}`, parent, graphic }
            this.autoStyles.set(key, entry)
        }
        return entry.name
    }

    /**
     * A paragraph with text properties of its own. LibreOffice ignores text
     * properties in automatic graphic styles, so they go on the paragraph.
     */
    para(text: string, props: Props): string {
        if (!text) return ""
        const key = JSON.stringify(props)
        let entry = this.paraStyles.get(key)
        if (!entry) {
            entry = { name: `Pg${this.paraStyles.size + 1}`, text: props }
            this.paraStyles.set(key, entry)
        }
        return `<text:p text:style-name="${entry.name}">${xmlText(text)}</text:p>`
    }

    /** A Graphviz diagram as a group of native shapes linked by connectors. */
    graphXml(path: string, x: number, y: number, w: number, h: number): string {
        const g = graphLayout(path)
        // Do not blow small diagrams up: text keeps its size, shapes would not.
        const maxScale = style.theme.graph.maxScale
        if (w > g.size[0] * maxScale) {
            const [fw, fh] = fit(g.size[0], g.size[1], g.size[0] * maxScale, g.size[1] * maxScale)
            x += (w - fw) / 2
            y += (h - fh) / 2
            w = fw
            h = fh
        }
        const scale = (w / g.size[0]) * CM_PER_POINT
        // Text follows the diagram scale, starting from the font sizes of the .dot file.
        const textProps = (fontsize: unknown, fallback: number, color: unknown): Props => {
            const pt = Math.max(4, Math.round(Number(fontsize ?? fallback) * (scale / CM_PER_POINT) * 2) / 2)
            const c = gvColor(color)
            return { "fo:font-size": `${pt}pt`, ...(c ? { "fo:color": c } : {}) }
        }
        const [bx0, , , by1] = g.bb
        const px = (p: number) => x + (p - bx0) * scale
        const py = (p: number) => y + (by1 - p) * scale
        const id = (gvid: number) => `g${this.graphCount}n${gvid}`
        this.graphCount++
        const out: string[] = [`<draw:g>`]

        const title = gvLabel(g.attrs.label ?? "", g.name, g.name)
        if (title && typeof g.attrs.lp === "string") {
            const [lx, ly] = gvPoint(g.attrs.lp)
            const lw = Number(g.attrs.lwidth ?? 1) * 72 * scale + 0.4
            const lh = Number(g.attrs.lheight ?? 0.3) * 72 * scale + 0.2
            const text = this.para(title, textProps(g.attrs.fontsize, sizes.graphEdgeText, g.attrs.fontcolor))
            out.push(this.frame("Graphe-titre", px(lx) - lw / 2, py(ly) - lh / 2, lw, lh, text))
        }

        // Clusters first, so they stay behind the nodes.
        for (const o of g.objects) {
            if (typeof o.bb !== "string" || !o.name.startsWith("cluster")) continue
            const [x0, y0, x1, y1] = o.bb.split(",").map(Number)
            const fill = gvColor(o.fillcolor) ?? (String(o.style ?? "").includes("filled") ? gvColor(o.color) : null)
            const stroke = gvColor(o.pencolor) ?? gvColor(o.color)
            const st = this.autoStyle(
                "Graphe-groupe",
                { ...(fill ? { "draw:fill-color": fill } : {}), ...(stroke ? { "svg:stroke-color": stroke } : {}), ...dashed(o.style) },
            )
            const label = gvLabel(o.label ?? "", o.name, g.name)
            out.push(
                `<draw:rect draw:style-name="${st}" ${Builder.geom(px(x0), py(y1), (x1 - x0) * scale, (y1 - y0) * scale)}>` +
                    this.para(label, textProps(o.fontsize, sizes.graphEdgeText, o.fontcolor)) +
                    `</draw:rect>`,
            )
        }

        for (const o of g.objects) {
            if (typeof o.pos !== "string") continue
            const [cx, cy] = gvPoint(o.pos)
            const nw = Number(o.width ?? 0.75) * 72 * scale
            const nh = Number(o.height ?? 0.5) * 72 * scale
            const shape = String(o.shape ?? "ellipse")
            const styles = String(o.style ?? "")
            const plain = ["plaintext", "plain", "none", "underline"].includes(shape) || styles.includes("invis")
            let geometry = NODE_SHAPES[shape] ?? "rectangle"
            if (geometry === "rectangle" && styles.includes("rounded")) geometry = "round-rectangle"
            const fill = styles.includes("filled") ? (gvColor(o.fillcolor) ?? gvColor(o.color)) : null
            const stroke = gvColor(o.color)
            const st = this.autoStyle(
                plain ? "Graphe-texte" : "Graphe-noeud",
                { ...(fill ? { "draw:fill-color": fill } : {}), ...(stroke && !plain ? { "svg:stroke-color": stroke } : {}), ...(plain ? {} : dashed(o.style)) },
            )
            const label = shape === "point" ? "" : gvLabel(o.label, o.name, g.name, shape.endsWith("record"))
            const nid = id(o._gvid)
            out.push(
                `<draw:custom-shape draw:style-name="${st}" draw:id="${nid}" xml:id="${nid}" ${Builder.geom(px(cx) - nw / 2, py(cy) - nh / 2, nw, nh)}>` +
                    this.para(label, textProps(o.fontsize, sizes.graphText, o.fontcolor)) +
                    `<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${geometry}"/>` +
                    `</draw:custom-shape>`,
            )
        }

        const kind = style.theme.graph.connector
        for (const e of g.edges) {
            const tokens = String(e.pos ?? "").split(/\s+/).filter(Boolean)
            const points = tokens.filter(t => !/^[se],/.test(t)).map(gvPoint)
            const startTip = tokens.find(t => t.startsWith("s,"))
            const endTip = tokens.find(t => t.startsWith("e,"))
            let start = startTip ? gvPoint(startTip.slice(2)) : (points[0] ?? [0, 0])
            let end = endTip ? gvPoint(endTip.slice(2)) : (points[points.length - 1] ?? [0, 0])
            let [tail, head] = [e.tail, e.head]
            const dir = String(e.dir ?? (g.directed ? "forward" : "none"))
            if (dir === "back") {
                ;[tail, head] = [head, tail]
                ;[start, end] = [end, start]
            }
            const parent = dir === "none" ? "Graphe-lien-simple" : dir === "both" ? "Graphe-lien-double" : "Graphe-lien"
            const stroke = gvColor(e.color)
            const st = this.autoStyle(parent, { ...(stroke ? { "svg:stroke-color": stroke } : {}), ...dashed(e.style) })
            const label = gvLabel(e.label ?? "", "", g.name)
            out.push(
                `<draw:connector draw:style-name="${st}" draw:type="${esc(kind)}" ` +
                    `svg:x1="${f2(px(start[0]))}cm" svg:y1="${f2(py(start[1]))}cm" svg:x2="${f2(px(end[0]))}cm" svg:y2="${f2(py(end[1]))}cm" ` +
                    `draw:start-shape="${id(tail)}" draw:end-shape="${id(head)}">` +
                    this.para(label, textProps(e.fontsize, sizes.graphEdgeText, e.fontcolor)) +
                    `</draw:connector>`,
            )
        }
        out.push("</draw:g>")
        return out.join("")
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
                return this.frame("Master-outline1", x, y, w, h, this.listXml(b.items), "outline")
            case "quote":
                return this.frame("Citation", x, y, w, h, `<text:p>${runsXml(b.text)}</text:p>`)
            case "prompt":
            case "code": {
                const [pw] = promptSize(b.lines, w)
                return this.promptXml(b.lines, x + w - pw, y, pw, h, b.t === "prompt" ? "Prompt" : "Code")
            }
            case "table": {
                const tw = Math.min(w, tableCols(b.header, b.rows, w).reduce((a, c) => a + c, 0))
                return this.tableXml(b.header, b.rows, x, y, tw, sizes.table)
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

        const stack = (bs: Block[], x: number, width: number): number => {
            let y = Y0
            for (const b of bs) {
                const bh = blockH(b, width)
                shapes.push(this.blockXml(b, x, y, width, Math.min(bh, Math.max(Y0 + H - y, 1.5))))
                y += bh + GAP
            }
            return y - Y0 - (bs.length ? GAP : 0)
        }
        const sumH = (width: number) => texts.reduce((h, b) => h + blockH(b, width), 0) + GAP * (texts.length - 1)

        if (!imgs.length) return [stack(texts, X0, W), shapes]
        const src = imgs[0].src
        const [iw, ih] = imageSize(resolve(this.base, src))
        if (!texts.length) {
            const [w, h] = fit(iw, ih, W, H)
            shapes.push(this.imageXml(src, X0 + (W - w) / 2, Y0 + (H - h) / 2, w, h))
            return [0, shapes]
        }
        if (iw / ih >= 1.8 || (iw / ih >= 1.2 && sumH(W) < 2.5)) {
            const th = stack(texts, X0, W)
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
            const cur = slides[slides.length - 1][0]
            const hasImg = cur.some(x => x.t === "image")
            if (cur.length && ((b.t === "image" && hasImg) || this.layout([...cur, b])[0] > H)) {
                // Keep an introductory paragraph with what follows it.
                const carry = cur.length > 1 && cur[cur.length - 1].t === "para" ? [cur.pop()!] : []
                slides.push([[...carry, b], []])
            } else {
                cur.push(b)
            }
        }
        return slides.filter(([c, n]) => c.length || n.length)
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
        const crumbs = sec.path().slice(0, -1)
        const shapes = [this.frame("Section-title", 2, 5, 24, 3.5, `<text:p>${xmlText(sec.title)}</text:p>`, "title", this.takeHints())]
        if (crumbs.length)
            shapes.push(this.frame("Section-subtitle", 2, 8.8, 24, 1.5, `<text:p>${xmlText(crumbs.join(" › "))}</text:p>`, "subtitle"))
        const notes = sec.blocks.flatMap(b => (b.t === "note" ? [b.text] : []))
        this.page("Section", shapes, notes)
    }

    contentPages(title: string, crumbs: string[], blocks: Block[]) {
        for (const [content, notes] of this.paginate(blocks)) {
            const [, shapes] = this.layout(content)
            this.page("Master", [...this.titleShapes(title, crumbs), ...shapes], notes)
        }
    }

    /** A table whose rows appear one slide after the other. */
    revealTable(sec: Section, crumbs: string[]) {
        const table = sec.blocks.find(b => b.t === "table")
        if (!table || table.t !== "table") return this.contentPages(sec.title, crumbs, sec.blocks)
        const header = (table.header ?? []).map(stripMd)
        const rows = table.rows
        const ncol = Math.max(header.length, ...rows.map(r => r.length))
        const hasLogos = rows.some(r => /<img\s/.test(r[0] ?? ""))
        const widths = tableCols(header, rows.map(r => (hasLogos ? ["Logo", ...r.slice(1)] : r)), Math.min(W, 4.5 * ncol))
        const tw = widths.reduce((a, b) => a + b, 0)
        const x = X0 + (W - tw) / 2
        const rh = 1.3
        const hh = 1.1
        for (let k = 0; k <= rows.length; k++) {
            const parts = [
                `<draw:frame draw:style-name="Tableau-cadre" ${Builder.geom(x, Y0, tw, hh + rh * rows.length)}>`,
                '<table:table table:template-name="Tableau" table:use-first-row-styles="true" table:use-banding-rows-styles="true">',
                ...widths.map(cw => `<table:table-column table:style-name="${this.colStyle(cw)}"/>`),
                `<table:table-row table:style-name="${this.rowStyle(hh)}">`,
                ...widths.map((_, c) => `<table:table-cell table:style-name="Tableau-entete"><text:p>${xmlText(header[c] ?? "")}</text:p></table:table-cell>`),
                "</table:table-row>",
            ]
            rows.forEach((r, i) => {
                const st = i % 2 === 0 ? "Tableau-cellule" : "Tableau-cellule-alt"
                parts.push(`<table:table-row table:style-name="${this.rowStyle(rh)}">`)
                widths.forEach((_, c) => {
                    const cell = i < k && !(hasLogos && c === 0) ? (r[c] ?? "") : ""
                    parts.push(`<table:table-cell table:style-name="${st}"><text:p>${runsXml(cell)}</text:p></table:table-cell>`)
                })
                parts.push("</table:table-row>")
            })
            parts.push("</table:table></draw:frame>")
            const shapes = [parts.join("")]
            for (let i = 0; i < k; i++) {
                const m = (rows[i][0] ?? "").match(/src="([^"]+)"/)
                if (m) {
                    const s = 1.0
                    shapes.push(this.imageXml(m[1], x + (widths[0] - s) / 2, Y0 + hh + rh * i + (rh - s) / 2, s, s))
                }
            }
            const notes = k === 0 ? sec.blocks.flatMap(b => (b.t === "note" ? [b.text] : [])) : []
            this.page("Master", [...this.titleShapes(sec.title, crumbs), ...shapes], notes)
        }
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
                for (let c = 0; c < ncol; c++) tw += Math.max(...all.map(r => Math.min(plainLen(r[c] ?? ""), 30))) * cw(sizes.tableSmall) + 0.6
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
            if (b.t === "note") continue
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
                    .map(b => (b.t === "list" ? this.listXml(b.items) : b.t === "para" || b.t === "quote" ? `<text:p>${runsXml(b.text)}</text:p>` : ""))
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
    layoutPage(parent: Section, group: Section[], layout: Layout, notes: string[]) {
        const title = parent.level > 0 ? parent.title : group[0].title
        const shapes = this.titleShapes(title, parent.path().slice(0, -1))
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
            shapes.push(this.frame(headStyle, x, y, w, headH, `<text:p>${xmlText(sec.title)}</text:p>`))
            shapes.push(...this.cellXml(sec, x, y + headH, w, h - headH, textStyle, textPt))
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
        if (sec.level === 1) {
            this.sectionPage(sec)
            if (content.length) this.contentPages(sec.title, [...crumbs, sec.title], sec.blocks)
        } else if (sec.hints.some(h => h.includes("revealed line by line"))) {
            this.revealTable(sec, crumbs)
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
            this.layoutPage(sec, group, layout, i === 0 ? notes : [])
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

function stylesXml(): string {
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
            `<draw:rect draw:style-name="Decor" ${Builder.geom(0, 0, 0.4, SLIDE_H)}/>` +
            `<draw:line draw:style-name="Decor-ligne" svg:x1="${X0}cm" svg:y1="2.7cm" svg:x2="${X0 + W}cm" svg:y2="2.7cm"/>` +
            placeholder("Master-title", "title", X0, 0.95, W, 1.6) +
            placeholder("Master-outline1", "outline", X0, Y0, W, H) +
            `${notes("Master")}</style:master-page>`,
        `<style:master-page style:name="Section" style:page-layout-name="PM1" draw:style-name="Mdp1">` +
            `<draw:rect draw:style-name="Section-fond" ${Builder.geom(0, 0, SLIDE_W, SLIDE_H)}/>` +
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
    for (const [key, name] of b.colStyles)
        auto.push(`<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${key}cm"/></style:style>`)
    for (const { name, parent, graphic } of b.autoStyles.values())
        auto.push(
            `<style:style style:name="${name}" style:family="graphic" style:parent-style-name="${esc(parent)}">` +
                `<style:graphic-properties ${attrs(graphic)}/></style:style>`,
        )
    for (const { name, text } of b.paraStyles.values())
        auto.push(`<style:style style:name="${name}" style:family="paragraph"><style:text-properties ${attrs(text)}/></style:style>`)
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

function writeOdp(b: Builder, out: string, title: string) {
    const pics = [...b.pictures.values()]
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
            { name: "styles.xml", data: text(stylesXml()) },
            { name: "content.xml", data: text(contentXml(b)) },
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

function convert(src: string, config: StyleConfig): { out: string; hints: number } {
    useStyle(config)
    const root = parse(readFileSync(src, "utf8"), src)
    const b = new Builder(dirname(src))
    b.walkChildren(root)
    const out = src.replace(/\.md$/i, ".odp")
    writeOdp(b, out, basename(src, extname(src)))
    return { out, hints: countHints(root) }
}

/** A ready-to-paste prompt asking an AI agent to apply the `@hint` pragmas of the given presentations. */
function aiPrompt(files: string[]): string {
    const rule = "-".repeat(72)
    return [
        rule,
        `Refine ${files.length > 1 ? "these LibreOffice Impress presentations" : "this LibreOffice Impress presentation"}:`,
        ...files.map(f => `  - ${f}`),
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
    ["@graph <file.dot>", "Insert a Graphviz diagram (path relative to the .md) as native shapes editable in Impress."],
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
    for (const f of args) if (!files.includes(f)) console.warn(`Ignoring ${f}: not a .md file`)
    if (!files.length) {
        console.error("No .md file given. Run without arguments for help.")
        process.exit(1)
    }
    await loadGraphviz()
    const withHints: [string, number][] = []
    let failed = false
    for (const file of files) {
        const src = resolve(file)
        console.log(`Processing ${src}`)
        try {
            const { config, path, created } = loadStyle(src)
            console.log(created ? `  + ${path} (created with the default style)` : `  ⚙ ${path}`)
            const { out, hints } = convert(src, config)
            console.log(`  → ${out} (${humanSize(statSync(out).size)})`)
            if (hints) withHints.push([out, hints])
        } catch (err) {
            failed = true
            console.error(`  ✗ ${err instanceof Error ? err.message : err}`)
        }
    }
    if (withHints.length) {
        console.log("\nThese presentations contain @hint pragmas (stored in the slide titles' alt-text descriptions)")
        console.log("and can be refined with AI:")
        for (const [out, n] of withHints) console.log(`  - ${out} (${n} hint${n > 1 ? "s" : ""})`)
        console.log("\nExample of prompt to give to an AI agent able to read and write files:\n")
        console.log(aiPrompt(withHints.map(([out]) => out)))
    }
    if (failed) process.exit(1)
}

await main(process.argv.slice(2))
