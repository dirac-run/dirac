/**
 * Action types that can be triggered from banner buttons/links
 * Frontend maps these to actual handlers
 */
export enum BannerActionType {
    /** Open external URL */
    Link = "link",
    /** Open API settings tab */
    ShowApiSettings = "show-api-settings",
    /** Open feature settings tab */
    ShowFeatureSettings = "show-feature-settings",
    /** Open account/login view */
    ShowAccount = "show-account",
    /** Set the active model */
    SetModel = "set-model",
    /** Trigger CLI installation flow */
    InstallCli = "install-cli",
}

/**
 * Banner data structure for backend-to-frontend communication.
 * Backend constructs this JSON, frontend renders it via BannerCarousel.
 */
export interface BannerCardData {
    /** Unique identifier for the banner (used for dismissal tracking) */
    id: string

    /** Banner title text */
    title: string

    /** Banner description/body markdown text */
    description: string

    /**
     * Icon ID from Lucide icon set (e.g., "lightbulb", "megaphone", "terminal")
     * LINK: https://lucide.dev/icons/
     * Optional - if omitted, no icon is shown
     */
    icon?: string

    /**
     * Optional footer action buttons
     * Rendered below the description as prominent buttons
     */
    actions?: BannerAction[]

    /**
     * Platform filter - only show on specified platforms
     * If undefined, show on all platforms
     */
    platforms?: ("windows" | "mac" | "linux")[]

    /** Only show to Dirac users */
    isDiracUserOnly?: boolean
}

/**
 * Single action definition (button or link)
 */
export interface BannerAction {
    /** Button/link label text */
    title: string

    /**
     * Action type - determines what happens on click
     * Defaults to "link" if omitted
     */
    action?: BannerActionType

    /**
     * Action argument - interpretation depends on action type:
     * - Link: URL to open
     * - SetModel: model ID (e.g., "anthropic/claude-opus-4.5")
     * - Others: generally unused
     */
    arg?: string

    /**
     * Optional model picker tab to open when using SetModel action
     */
    tab?: "recommended" | "free"
}

/**
 * The list of predefined banner config rendered by the Welcome Section UI.
 * TODO: Backend would return a similar JSON structure in the future which we will replace this with.
 */

export const BANNER_DATA: BannerCardData[] = [
    // Sonnet 4.6 banner
    {
        // Bump this version string when copy/CTA changes and you want the banner to reappear.
        id: "claude-sonnet-4-6-2026-feb-18",
        icon: "sparkles",
        title: "Try Claude Sonnet 4.6",
        description: "Anthropic's latest model with strong reasoning and coding performance.",
        actions: [
            {
                title: "Use Sonnet 4.6",
                action: BannerActionType.SetModel,
                arg: "anthropic/claude-sonnet-4.6",
                tab: "recommended",
            },
        ],
    },

    // Minimax free promo banner
    {
        // Bump this version string when copy/CTA changes and you want the banner to reappear.
        id: "minimax-m3-free-2026-jul-08",
        icon: "zap",
        title: "Try MiniMax M3 Free",
        description: "Latest flagship model with 1M context, agentic reasoning, and tool use — free in Dirac.",
        actions: [
            {
                title: "Try now",
                action: BannerActionType.SetModel,
                arg: "minimax/MiniMax-M3",
                tab: "free",
            },
        ],
    },

    // ChatGPT integration banner
    {
        id: "chatgpt-integration-v1",
        icon: "megaphone",
        title: "Use ChatGPT with Dirac",
        description:
            "Bring your ChatGPT subscription to Dirac! Use your existing plan directly with no per token costs or API keys to manage.",
        actions: [
            {
                title: "Connect",
                action: BannerActionType.ShowApiSettings,
                arg: "openai-codex", // Pre-select OpenAI Codex provider
            },
        ],
    },

    // Jupyter Notebooks banner
    {
        id: "jupyter-notebooks-v1",
        icon: "book-open",
        title: "Jupyter Notebooks",
        description:
            "Comprehensive AI-assisted editing of `.ipynb` files with full cell-level context awareness. [Learn More →](https://dirac.run/docs/features/jupyter-notebooks)",
    },

    // Platform-specific banner (Windows)
    {
        id: "cli-info-windows-v1",
        icon: "terminal",
        title: "Dirac CLI Info",
        platforms: ["windows"] satisfies BannerCardData["platforms"],
        description:
            "Available for macOS and Linux. Coming soon to other platforms. [Learn more](https://dirac.run/docs/dirac-cli/overview)",
    },

    // Info banner with inline link
    {
        id: "info-banner-v1",
        icon: "lightbulb",
        title: "Use Dirac in Right Sidebar",
        description:
            "For the best experience, drag the Dirac icon to your right sidebar. This keeps your file explorer and editor visible while you chat with Dirac, making it easier to navigate your codebase and see changes in real-time. [See how →](https://dirac.run/docs/features/customization/opening-dirac-in-sidebar)",
    },
]
