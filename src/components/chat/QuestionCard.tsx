import {memo, useMemo, useState, type CSSProperties, type KeyboardEvent} from "react";
import {Check, MessageCircleQuestion} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {
    FormAnswer,
    FormField,
    FormFieldOption,
    FormRequest,
} from "../../opencode/types.ts";
import {fieldVisible, normalize} from "./formLogic.ts";
import {Card, CardButton, MONO} from "./RequestCardChrome.tsx";

/** Chrome-less answer inputs (custom text + plain text/number): no fill,
 *  no border, no focus ring — exactly the composer's editable. The hover
 *  wash (kept while focused) is the whole affordance; the blinking caret
 *  says "focused". */
const ANSWER_INPUT_CLASS =
    "w-full bg-transparent rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-none placeholder:opacity-40 " +
    "hover:bg-[var(--lum-answer-hover)] focus:bg-[var(--lum-answer-hover)] " +
    "transition-colors duration-[var(--duration-fast)]";

function answerInputVars(colors: SurfaceColors): CSSProperties {
    return {"--lum-answer-hover": colors.hoverOverlay} as CSSProperties;
}

/** Enter commits an answer input — but not the Enter that confirms an
 *  IME composition (CJK input), which must land as text, not submit. */
function answerEnter(e: KeyboardEvent, commit: () => void) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    commit();
}

/** The leading marker of an option row: the row number on
 *  single-selects, a checkbox on multiselects. */
function RowMarker({kind, index, selected, colors}: {
    kind: "number" | "checkbox";
    index: number;
    selected: boolean;
    colors: SurfaceColors;
}) {
    if (kind === "number") {
        return (
            <span
                className="shrink-0 w-4 text-[11px] font-medium text-center tabular-nums"
                style={{color: selected ? "var(--color-brand-lavender)" : colors.inactiveText}}
            >
                {index + 1}
            </span>
        );
    }
    return (
        <span
            className="shrink-0 w-4 h-4 rounded-[4px] flex items-center justify-center"
            style={selected
                ? {background: "var(--color-brand-lavender)", color: "#fff"}
                : {border: `1.5px solid ${colors.inactiveText}`}}
        >
            {selected && <Check size={11} strokeWidth={3}/>}
        </span>
    );
}

/** One selectable option as a full-width row: marker + label + dimmed
 *  inline description. Single fields behave like radios, multiselect
 *  toggles membership. */
function OptionRow({
    option,
    markerKind,
    index,
    selected,
    colors,
    onClick,
}: {
    option: FormFieldOption;
    markerKind: "number" | "checkbox";
    index: number;
    selected: boolean;
    colors: SurfaceColors;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            title={option.description}
            onClick={onClick}
            className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer select-none text-left hover:bg-[var(--lum-option-row-hover)] transition-colors duration-[var(--duration-fast)]"
            style={{
                background: selected ? colors.accentOverlay : undefined,
                "--lum-option-row-hover": colors.hoverOverlay,
                color: selected ? undefined : colors.inactiveText,
            } as CSSProperties}
        >
            <RowMarker kind={markerKind} index={index} selected={selected} colors={colors}/>
            <span className="shrink-0 text-xs font-medium">{option.label}</span>
            {option.description && (
                <span className="flex-1 min-w-0 text-xs opacity-60 truncate leading-normal">
                    {option.description}
                </span>
            )}
        </button>
    );
}

/** The free-text input shown under option rows on `custom` fields. */
function CustomTextInput({
    value,
    placeholder,
    colors,
    onChange,
    onCommit,
}: {
    value: string;
    placeholder: string;
    colors: SurfaceColors;
    onChange: (text: string) => void;
    /** Enter (outside IME composition) fires this — see {@link answerEnter}. */
    onCommit: () => void;
}) {
    return (
        <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={(e) => answerEnter(e, onCommit)}
            className={ANSWER_INPUT_CLASS}
            style={answerInputVars(colors)}
        />
    );
}

/** One question form: fields rendered from the server's schema (the
 *  question tool emits option-selects and free-text), answered in one
 *  batch. Multi-question forms page through ONE field at a time instead
 *  of stacking everything. For question forms the card header shows the
 *  current question's own header (the server hardcodes their title to
 *  "Questions" and stashes the real label in each field's title).
 *  Memoized; local answer state resets with the form id. */
export const QuestionCard = memo(function QuestionCard({
    form,
    colors,
    onReply,
    onCancel,
}: {
    form: FormRequest;
    colors: SurfaceColors;
    onReply: (form: FormRequest, answer: FormAnswer) => void;
    onCancel: (form: FormRequest) => void;
}) {
    const t = useI18n();
    const [answer, setAnswer] = useState<FormAnswer>({});
    // Free-text on `custom` fields. The question tool sets custom on BOTH
    // single- and multi-select fields ("or type your own"); typed text
    // overrides the picked options on single-selects and rides NEXT to
    // them on multi-selects.
    const [customText, setCustomText] = useState<Record<string, string>>({});

    const visible = useMemo(
        () => form.fields.filter((f) => fieldVisible(f, answer)),
        [form.fields, answer],
    );

    // One question per page — multi-question forms page through instead
    // of stacking every field in one card. Clamped against `visible`
    // shrinking (a `when` condition can hide a later field).
    const [page, setPage] = useState(0);
    const index = Math.min(page, visible.length - 1);
    const current = visible[index];
    const isLast = index >= visible.length - 1;

    // Question forms hardcode their title to "Questions" server-side and
    // put the real label in each field's title (the question's header) —
    // show THAT in the card header instead, with the question text
    // (description) as the body. Other forms keep their own title and
    // field titles.
    const isQuestion = form.metadata?.kind === "question";
    const header = isQuestion ? current?.title : form.title;

    const set = (key: string, value: FormAnswer[string]) =>
        setAnswer((prev) => ({...prev, [key]: value}));

    /** The typed free-text of a custom field, trimmed ("" = none). */
    const customOf = (f: FormField): string =>
        (f.type === "string" || f.type === "multiselect") && f.custom
            ? (customText[f.key] ?? "").trim()
            : "";

    /** A required field the user hasn't answered (options or custom). */
    const isMissing = (f: FormField) => {
        if (!f.required) return false;
        // A typed custom answer satisfies a required field too.
        if (customOf(f) !== "") return false;
        return normalize(f, answer[f.key]) === undefined;
    };
    const submit = () => {
        // Something required went unanswered on an earlier page — go
        // there instead of submitting (the button only gates the page
        // the user is looking at).
        const missIdx = visible.findIndex(isMissing);
        if (missIdx !== -1) {
            setPage(missIdx);
            return;
        }
        // Only visible fields ride in the payload; hidden branches were
        // never answered.
        const payload: FormAnswer = {};
        for (const f of visible) {
            let v = normalize(f, answer[f.key]);
            const extra = customOf(f);
            if (extra !== "") {
                v = f.type === "multiselect"
                    ? [...(Array.isArray(v) ? v : []), extra]
                    : extra; // single-select: the typed answer wins
            }
            if (v !== undefined) payload[f.key] = v;
        }
        onReply(form, payload);
    };

    /** Enter in an answer input commits the page — the same thing
     *  clicking the primary button does: next question, or send on the
     *  last one. No-ops when the button itself would be disabled. */
    const commitPage = () => {
        if (current == null || isMissing(current)) return;
        if (isLast) submit();
        else setPage(index + 1);
    };

    const inputStyle = answerInputVars(colors);

    /** The body of ONE field (the current page). */
    const renderField = (field: FormField) => (
        <div key={field.key} className="flex flex-col gap-1.5">
            {/* Question forms show the field title as the card header
                (see `header` above) — don't repeat it in the body. */}
            {field.title && !isQuestion && (
                <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{field.title}</span>
                    {field.required && (
                        <span className="text-[10px] uppercase tracking-wider" style={{color: "#f59e0b"}}>
                            {t["Answer required"]}
                        </span>
                    )}
                </div>
            )}
            {field.description && (
                <p className="text-xs leading-relaxed opacity-75">{field.description}</p>
            )}
            {field.type === "string" && field.options && field.options.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    {field.options.map((o, i) => (
                        <OptionRow
                            key={o.value}
                            option={o}
                            markerKind="number"
                            index={i}
                            // While custom text is typed, rows render
                            // unselected — the typed answer is what
                            // will be sent.
                            selected={customOf(field) === "" && answer[field.key] === o.value}
                            colors={colors}
                            onClick={() => {
                                // Picking a row replaces typed text.
                                if (field.custom) {
                                    setCustomText((prev) => ({...prev, [field.key]: ""}));
                                }
                                set(field.key, answer[field.key] === o.value ? "" : o.value);
                            }}
                        />
                    ))}
                    {field.custom && (
                        <CustomTextInput
                            value={customText[field.key] ?? ""}
                            placeholder={t["Type your answer…"]}
                            colors={colors}
                            onChange={(text) =>
                                setCustomText((prev) => ({...prev, [field.key]: text}))}
                            onCommit={commitPage}
                        />
                    )}
                </div>
            ) : field.type === "multiselect" ? (
                <div className="flex flex-col gap-1.5">
                    {field.options.map((o, i) => {
                        const held = (answer[field.key] as string[] | undefined) ?? [];
                        const selected = held.includes(o.value);
                        return (
                            <OptionRow
                                key={o.value}
                                option={o}
                                markerKind="checkbox"
                                index={i}
                                selected={selected}
                                colors={colors}
                                onClick={() =>
                                    set(field.key, selected
                                        ? held.filter((v) => v !== o.value)
                                        : [...held, o.value])}
                            />
                        );
                    })}
                    {field.custom && (
                        <CustomTextInput
                            value={customText[field.key] ?? ""}
                            placeholder={t["Type your answer…"]}
                            colors={colors}
                            onChange={(text) =>
                                setCustomText((prev) => ({...prev, [field.key]: text}))}
                            onCommit={commitPage}
                        />
                    )}
                </div>
            ) : field.type === "boolean" ? (
                <div className="flex flex-col gap-1.5">
                    {[true, false].map((v, i) => (
                        <OptionRow
                            key={String(v)}
                            option={{value: String(v), label: v ? t["Yes"] : t["No"]}}
                            markerKind="number"
                            index={i}
                            selected={answer[field.key] === v}
                            colors={colors}
                            onClick={() => set(field.key, v)}
                        />
                    ))}
                </div>
            ) : field.type === "external" ? (
                <span className="text-xs break-all" style={{fontFamily: MONO, opacity: 0.75}}>
                    {field.url}
                </span>
            ) : (
                <input
                    type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                    value={answer[field.key] as string | number | undefined ?? ""}
                    placeholder={field.type === "string" ? (field.placeholder ?? t["Type your answer…"]) : ""}
                    onChange={(e) => set(field.key, e.currentTarget.value)}
                    onKeyDown={(e) => answerEnter(e, commitPage)}
                    className={ANSWER_INPUT_CLASS}
                    style={inputStyle}
                />
            )}
        </div>
    );

    return (
        <Card colors={colors}>
            <div className="flex items-center gap-2 text-sm font-medium">
                <MessageCircleQuestion size={15} className="shrink-0" style={{color: "var(--color-brand-lavender)"}}/>
                {header && <span>{header}</span>}
                {visible.length > 1 && (
                    <span className="ml-auto shrink-0 text-xs opacity-50 tabular-nums select-none">
                        {index + 1} / {visible.length}
                    </span>
                )}
            </div>
            {current != null && renderField(current)}
            <div className="flex items-center justify-between gap-2">
                <CardButton label={t["Dismiss"]} colors={colors} onClick={() => onCancel(form)}/>
                <div className="flex items-center gap-2">
                    {visible.length > 1 && index > 0 && (
                        <CardButton label={t["Previous"]} colors={colors} onClick={() => setPage(index - 1)}/>
                    )}
                    {visible.length > 1 && !isLast ? (
                        <CardButton
                            label={t["Next"]}
                            primary
                            disabled={current != null && isMissing(current)}
                            colors={colors}
                            onClick={() => setPage(index + 1)}
                        />
                    ) : (
                        <CardButton
                            label={t["Send answers"]}
                            primary
                            disabled={current != null && isMissing(current)}
                            colors={colors}
                            onClick={submit}
                        />
                    )}
                </div>
            </div>
        </Card>
    );
});
