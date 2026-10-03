# Native filesystem operations

*On narrow screens, swipe tables horizontally to see every column.*

`filesystem.execute` dispatches seven tools on the gateway host. The daemon wraps the result with operation ID/replay information, while the Core adapter adds target, parent-run, tool-call, and remote execution provenance.

```json
{"id":"fs-1","method":"filesystem.execute","params":{"operationId":"fs-demo-001","tool":"files_list","arguments":{"dirPath":"/srv/burrow/workspaces/example","maxDepth":2,"maxEntries":100}}}
```

## Tool reference

| Tool | Arguments | Main result |
| --- | --- | --- |
| `files_read` | `filePath`, optional `offsetBytes`, `maxBytes`, `encoding`, `workspaceRoot` | Content, size/mtime, returned bytes, content hash, truncation and next offset |
| `files_inspect` | `path` | Exists/type/size/mtime and symlink target when applicable |
| `files_list` | `dirPath`, optional `maxDepth`, `maxEntries` | Relative entries with file/directory/symlink/other type |
| `files_find` | `dirPath`, optional `pattern` (default `*`), `maxDepth`, `maxEntries`, `maxTraversalEntries` | Relative matching paths and completeness metadata |
| `files_search` | `dirPath`, nonempty literal `query`, optional `maxDepth`, `maxMatches`, `maxTraversalEntries` | File, one-based line number, matching line excerpt |
| `files_write` | `filePath`, `content`, optional `workspaceRoot` | Creates parent directories and writes UTF-8; reports create/overwrite and byte count |
| `files_edit` | `filePath`, `oldText`, `newText` | Requires exactly one nonempty literal match, then replaces it |

Paths are resolved on the host using Node path handling and the service's working directory. Use explicit absolute paths. The gateway runner does not enforce `workspaceRoot` as a boundary. Operating-system permissions and the calling Core policy remain essential.

`files_write` overwrites an existing file. `files_edit` returns `old_text_not_found` or `old_text_not_unique` instead of guessing which occurrence to replace. Neither operation is a multi-file transaction.

`files_edit` matches `oldText` literally, but `newText` uses JavaScript string-replacement semantics: `$$` inserts a literal dollar sign, `$&` inserts the matched text, `` $` `` inserts the pre-match prefix, and `$'` inserts the post-match suffix. Do not assume dollar-containing replacement text is inserted verbatim; verify the resulting content.

`files_find` matches the full relative path, case-sensitively. `*` and `?` do not cross `/`; `**` does, and `**/` also matches zero directory components. For example, `**/*.mjs` matches both top-level and nested `.mjs` paths. The default `*` matches only top-level paths even though traversal may visit deeper entries. Matches can include directories and symlinks as well as files. Brace expansion and character classes are not supported.

## Traversal and output bounds

| Bound | Default |
| --- | --- |
| List depth | 4 |
| Find/search depth | 8 |
| List returned/traversed entries | 500 |
| Find returned paths | 500 |
| Find/search traversal budget | 4,000 entries |
| Search returned matches | 200 |
| Read returned bytes | 512,000 |
| Search line excerpt | 1,000 characters |

Valid explicit positive bounds override the traversal/result defaults. Null, omitted, empty, invalid, or nonpositive traversal bounds select defaults. `BURROW_FILESYSTEM_TRAVERSAL_ENTRIES` sets the host default traversal budget for find/search; per-request `maxTraversalEntries` takes precedence.

Traversal sorts names, skips dot-prefixed entries and `node_modules`, and does not recursively follow symlink directories. Listing a symlink is different from reading a supplied path that the operating system resolves through a symlink.

## Completeness is part of the result

- `depthTruncated`: deeper visible contents were not traversed
- `entryBudgetExhausted`: the traversal budget ended before all entries were visited
- `truncated`: a depth, traversal, or returned-result limit was reached
- `incomplete`: traversal is truncated or has warnings
- `warnings`: unreadable directories/files and bound-related explanations

An empty match set does not prove no matching file exists outside the visited subset. Hidden entries and `node_modules` are intentionally excluded. Use the returned metadata when reporting search results to a user or model.

The current read/search implementation reads each selected file into memory before applying its returned-content limit. Returned-byte limits are not file-size or total-memory limits. Avoid unbounded or unexpectedly large files in automated workflows and choose conservative scopes.

## Errors and cancellation

Errors are returned as tool results with `ok: false`, a normalized code/diagnostic, relevant path when available, and duration/fingerprint metadata. Transport-level `ok: true` can still contain a filesystem outcome with `ok: false`.

Cancellation is checked before operations and during traversal/search loops. It cannot be assumed to undo a write or interrupt every individual file I/O operation. After an interrupted write, inspect actual contents before retrying.

## Source references

- [`gateway/lib/filesystem-runner.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/lib/filesystem-runner.mjs)
- [`gateway/filesystem-runner.test.mjs`](https://github.com/NightShaman/Node-Goblin/blob/12d0f1daf74516e1f0120c80ad4716bd09e1dead/gateway/filesystem-runner.test.mjs)
