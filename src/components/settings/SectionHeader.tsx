/** A section header in the Typography group's style (also AboutSettings'
 *  dependencies header) — one look for every settings section. */
export default function SectionHeader({label}: {label: string}) {
    return (
        <div className="text-xs font-medium uppercase tracking-wide pb-1 opacity-55">
            {label}
        </div>
    );
}
