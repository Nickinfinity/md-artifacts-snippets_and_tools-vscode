# Change Log

All notable changes to the "md-artifacts-snippets-and-tools-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- **Templates now create whole files.** Right-click a folder (or file) in the
  Explorer and choose **Insert Template** to write a template to disk as a
  real file — its `<VK-xxx>` variables filled in first, and the file opens
  automatically. The new file's name and extension are suggested from the
  template (a `extension:` field in the template, or its code language) and are
  fully editable before you confirm.
- Templates can now be created from **Create Artifact**, with an optional
  **File extension** field.

### Changed

- **Breaking:** Templates no longer appear in the **editor** right-click menu.
  A template writes a file into your project rather than inserting text at the
  cursor, so it now lives only in the **Explorer** right-click menu as
  *Insert Template*. If you previously used "Insert Templates" from the
  editor, use a Snippet instead, or invoke the template from the Explorer.

- Initial release