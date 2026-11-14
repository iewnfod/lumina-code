import {useMemo} from "react";
import {collectSessionSubagents, type SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import {groupPermissionRequests, type PermissionGroup} from "./permissionGroups.ts";
import type {
    ChatMessage,
    FormRequest,
    PermissionRequest,
} from "../../opencode/types.ts";

/**
 * Subagent children's asks, derived for the conversation the user is
 * watching: a child session blocked on the server (its
 * permission/question waiting) surfaces HERE — the sidebar lists root
 * sessions only, so the child has no row to badge or open. The child
 * link (spawn part metadata.sessionID) is in the store before the
 * child's first ask can arrive, so this derivation is never late. Same
 * collector + identity discipline as the stats panel
 * (useSessionActivity re-runs it per frame too). Extracted from
 * ChatView's inline memos.
 */
export function useSubagentRequests(
    messages: readonly ChatMessage[],
    allPermissions: readonly PermissionRequest[],
    allForms: readonly FormRequest[],
): {
    childPermissionGroups: {key: string; group: PermissionGroup; child: SessionSubagentRef}[];
    childForms: {form: FormRequest; child: SessionSubagentRef}[];
} {
    const subagentChildren = useMemo(
        () => collectSessionSubagents(messages as ChatMessage[]),
        [messages],
    );
    const childById = useMemo(
        () => new Map(subagentChildren.map((child) => [child.id, child])),
        [subagentChildren],
    );
    const childPermissionGroups = useMemo(() => {
        if (subagentChildren.length === 0) return [];
        return groupPermissionRequests(allPermissions.filter((p) => childById.has(p.sessionID))).map(
            (group) => ({
                key: `${group.requests[0].sessionID}:${group.key}`,
                group,
                child: childById.get(group.requests[0].sessionID)!,
            }),
        );
    }, [allPermissions, subagentChildren, childById]);
    const childForms = useMemo(
        () =>
            subagentChildren.length === 0
                ? []
                : allForms
                      .filter((f) => childById.has(f.sessionID))
                      .map((form) => ({form, child: childById.get(form.sessionID)!})),
        [allForms, subagentChildren, childById],
    );
    return {childPermissionGroups, childForms};
}
