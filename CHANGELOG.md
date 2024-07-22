## Unrelease

## 0.6.0 - 2024-07-22

### Changed

- The gcov binary can now be overridden per workspace or folder.

### Fixed

- Slightly improved error reporting when invoking gcov.

## 0.5.0 - 2022-12-04

### Added

- Show function coverage in percent.
- Show file coverage in status bar.
- New `Generate Summary as HTML` command.

### Changed

- The `View Functions by Call Count` command now shortens templated function names.

## 0.4.0 - 2020-08-26

### Fixed

- Better support for Windows paths when using MinGW-gcc.

## 0.3.0 - 2020-07-11

### Changed

- Suggest using `--coverage` instead of `-fprofile-arcs -ftest-coverage` in readme.
- Sort lines in tooltip by call count.
- Improve error messages.

## 0.2.0 - 2020-06-21

### Changed

- Renamed "include directories" to "build directories".
- Improved error message when no .gcda files have been found.
- Make gcc version requirement a bit more clear in readme.

## 0.1.0 - 2020-06-20

### Added

- New `Gcov Viewer: Show` command.
- New `Gcov Viewer: Hide` command.
- New `Gcov Viewer: Toggle` command.
- New `Gcov Viewer: Reload .gcda Files` command.
- New `Gcov Viewer: Delete .gcda Files` command.
- New `Gcov Viewer: Select Include Directory` command.
- New `Gcov Viewer: Dump Paths with Coverage Data` command.
- New `Gcov Viewer: View Functions by Call Count` command.
- New `gcovViewer.includeDirectories` setting.
- New `gcovViewer.gcovBinary` setting.
- New `gcovViewer.highlightMissedLines` setting.
