import { type ChokidarOptions, type FSWatcher } from "chokidar"

export const LOCK_TEXT_SYMBOL = "\u{1F512}"

export const DEFAULT_IGNORE_PATTERNS = [
	// Version control
	".git",
	".svn",
	".hg",
	".fslckout",
	"_fslckout",
	".bzr",
	"_darcs",
	".fossil-settings",

	// Dependencies
	"node_modules",
	"bower_components",
	"jspm_packages",
	"vendor",
	".cache",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".venv",
	"venv",
	"env",
	".env",
	".yarn",

	// Build & Output
	"dist",
	"build",
	"out",
	"target",
	"bin",
	"obj",
	"gen",
	"CMakeFiles",
	".gradle",
	".turbo",
	".next",
	".nuxt",
	".svelte-kit",
	"coverage",
	".nyc_output",
	"__snapshots__",

	// IDEs
	".idea",
	".vs",
	".vscode",
	"*.egg-info",
	"*.suo",
	"*.user",
	"*.userosscache",
	"*.sln.doccache",
	"*.ncb",

	// OS files
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",

	// Binaries & Archives
	"*.vsix",
	"*.zip",
	"*.tar",
	"*.tar.gz",
	"*.tgz",
	"*.tar.bz2",
	"*.tar.xz",
	"*.gz",
	"*.jar",
	"*.war",
	"*.ear",
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
	"*.a",
	"*.o",
	"*.obj",
	"*.class",
	"*.pyc",
	"*.pyo",
	"*.wasm",
	"*.bin",
	"*.dat",
	"*.db",
	"*.sqlite",
	"*.sqlite3",
	"*.pdb",

	// Locks & Metadata
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Gemfile.lock",
	"Cargo.lock",
	"composer.lock",
	"poetry.lock",
	"Pipfile.lock",
	"bun.lockb",

	// Misc
	"*.min.js",
	"*.min.css",
	"*.map",
]

export const INCLUDE_PREFIX = "!include "

export type WatcherFactory = (path: string, options?: ChokidarOptions) => FSWatcher
