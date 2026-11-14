import {useCallback, useState} from "react";
import type {SettingsTab} from "../components/settings/SettingsPage.tsx";

/**
 * App's overlay-surface orchestration — the settings PAGE state (the
 * sidebar gear's toggle + the model picker's deep-link entry), the
 * MOBILE drawer and the session-import modal. Extracted from AppBody so
 * the chrome component reads as layout; every value here stays App-level
 * (entry points live across the tree: TitleBar, SessionBar, ChatView).
 */

export function useAppSurfaces() {
    // The settings PAGE (the sidebar's bottom-left gear toggles it, and
    // the model picker's empty-state entry deep-links to its Model
    // tab): a full-area surface OVER the conversation canvas — the
    // conversation stays mounted underneath, its transcripts and
    // streamed deltas untouched. App owns open + tab so entry points
    // can preselect the pane. A NULL tab is the mobile root (the
    // settings CATEGORY LIST — the second-level page navigation); the
    // desktop page reads it as "general".
    const [settings, setSettings] = useState<{open: boolean; tab: SettingsTab | null}>({open: false, tab: null});
    const openSettings = useCallback((tab: SettingsTab | null = null) => {
        setSettings({open: true, tab});
    }, []);
    const closeSettings = useCallback(() => {
        setSettings((prev) => ({...prev, open: false}));
    }, []);
    // The sidebar gear's toggle: opening RESUMES the last-viewed pane
    // (the tab survives a close; only a deep-link overrides it).
    const toggleSettings = useCallback(() => {
        setSettings((prev) => (prev.open ? {...prev, open: false} : {open: true, tab: prev.tab}));
    }, []);
    const setSettingsTab = useCallback((tab: SettingsTab | null) => {
        setSettings((prev) => (prev.tab === tab ? prev : {...prev, tab}));
    }, []);

    // The MOBILE drawer (the phone layout's only session navigation —
    // TitleBar's hamburger).
    const [drawerOpen, setDrawerOpen] = useState(false);
    const closeDrawer = useCallback(() => setDrawerOpen(false), []);

    // The session-import picker (the sidebar's Import row).
    const [importOpen, setImportOpen] = useState(false);

    return {
        settings, openSettings, closeSettings, toggleSettings,
        setSettingsTab,
        drawerOpen, setDrawerOpen, closeDrawer,
        importOpen, setImportOpen,
    };
}
