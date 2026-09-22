import {memo} from "react";
import {ShieldAlert} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {PermissionDecision, PermissionRequest} from "../../opencode/types.ts";
import {Card, CardButton, MONO} from "./RequestCardChrome.tsx";

/** Human phrase per permission action (observed set on server v2.0.11);
 *  unknown actions fall back to a capitalized raw name. */
function permissionPhrase(action: string, t: ReturnType<typeof useI18n>): string {
    switch (action) {
        case "external_directory": return t["Access a folder outside the project"];
        case "bash": case "shell": return t["Run a shell command"];
        case "edit": case "apply_patch": return t["Edit a file"];
        case "write": return t["Write a file"];
        case "read": return t["Read files"];
        case "webfetch": return t["Fetch a web page"];
        case "websearch": return t["Search the web"];
        case "question": return t["Ask you questions"];
        default: return action.charAt(0).toUpperCase() + action.slice(1);
    }
}

/** One pending permission request: what it wants + the resources it
 *  names, with once / always / reject. Memoized — the card is static
 *  until it disappears. */
export const PermissionCard = memo(function PermissionCard({
    request,
    colors,
    onDecision,
}: {
    request: PermissionRequest;
    colors: SurfaceColors;
    onDecision: (request: PermissionRequest, decision: PermissionDecision) => void;
}) {
    const t = useI18n();
    return (
        <Card colors={colors}>
            <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert size={15} className="shrink-0" style={{color: "#f59e0b"}}/>
                <span>{permissionPhrase(request.action, t)}</span>
            </div>
            {request.resources.length > 0 && (
                <div
                    className="flex flex-col gap-0.5 pl-6 max-h-32 overflow-y-auto"
                    style={{fontFamily: MONO}}
                >
                    {request.resources.map((r, i) => (
                        <span key={i} className="text-xs opacity-70 break-all">{r}</span>
                    ))}
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <CardButton label={t["Reject"]} colors={colors} onClick={() => onDecision(request, "reject")}/>
                <CardButton label={t["Always allow"]} colors={colors} onClick={() => onDecision(request, "always")}/>
                <CardButton label={t["Allow once"]} primary colors={colors} onClick={() => onDecision(request, "once")}/>
            </div>
        </Card>
    );
});
