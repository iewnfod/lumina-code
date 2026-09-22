/**
 * Source language table. Keys are the English originals; the i18n store
 * resolves every lookup against this table so a translation that is missing
 * a key falls back to English instead of rendering nothing.
 */
const enUs = {
    "Command Palette": "Command Palette",
    "Pin on Top": "Pin on Top",
    "Unpin from Top": "Unpin from Top",
    "Always on top is not supported on Wayland": "Always on top is not supported on Wayland",
    "New Session": "New Session",
    "Other Sessions": "Other Sessions",
    "Show more": "Show more",
    "Show less": "Show less",
    "Good morning": "Good morning",
    "Good afternoon": "Good afternoon",
    "Good evening": "Good evening",
    "Good night": "Good night",
    "Connecting to OpenCode…": "Connecting to OpenCode…",
    "Ask Lumina Code, use @ to add context, use / for commands": "Ask Lumina Code, use @ to add context, use / for commands",
    "Connection error": "Connection error",
    "Send": "Send",
    "Stop": "Stop",
    "Mode": "Mode",
    "Model": "Model",
    "Thinking depth": "Thinking depth",
    "Project": "Project",
    "Default project directory": "Default project directory",
    "Recent Projects": "Recent Projects",
    "Browse…": "Browse…",
    "Choose This Folder": "Choose This Folder",
    "Add attachment": "Add attachment",
    "Remove attachment": "Remove attachment",
    "No matching commands": "No matching commands",
    "No matching files": "No matching files",
    // --- Transcript run footer ---
    "Copy": "Copy",
    "Copied": "Copied",
    "Task duration": "Task duration",
    // --- Permission requests & questions ---
    "Permission request": "Permission request",
    "Access a folder outside the project": "Access a folder outside the project",
    "Run a shell command": "Run a shell command",
    "Edit a file": "Edit a file",
    "Write a file": "Write a file",
    "Read files": "Read files",
    "Fetch a web page": "Fetch a web page",
    "Search the web": "Search the web",
    "Ask you questions": "Ask you questions",
    "Allow once": "Allow once",
    "Always allow": "Always allow",
    "Reject": "Reject",
    "Send answers": "Send answers",
    "Dismiss": "Dismiss",
    "Answer required": "Answer required",
    "Type your answer…": "Type your answer…",
    "Previous": "Previous",
    "Next": "Next",
    // --- Settings ---
    "Language": "Language",
    "Follow System": "Follow System",
} as const;

export type TranslationKey = keyof typeof enUs;

export default enUs;
