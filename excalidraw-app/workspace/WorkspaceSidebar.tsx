import { useEffect, useId, useRef, useState } from "react";

import {
  LoadIcon,
  PlusIcon,
  chevronDownIcon,
  chevronLeftIcon,
  chevronRight,
  file,
  save,
} from "@excalidraw/excalidraw/components/icons";

import "./WorkspaceSidebar.scss";

import type { Workspace } from "./workspace";

type WorkspaceSidebarProps = {
  workspace: Workspace | null;
  dirty: boolean;
  busy: boolean;
  disabled: boolean;
  fileName: string | null;
  onAddCollection: (name: string) => void;
  onAddCanvas: (collectionId: string, name: string) => void;
  onSelectCanvas: (id: string) => void;
  onSave: () => void;
  onOpen: () => void;
};

const NameForm = ({
  label,
  disabled,
  onCreate,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="workspace-sidebar__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && name.trim()) {
          onCreate(name.trim());
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <label htmlFor={inputId}>{label}</label>
      <input
        ref={inputRef}
        id={inputId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        required
      />
      <div className="workspace-sidebar__form-actions">
        <button
          type="submit"
          className="workspace-sidebar__button workspace-sidebar__button--primary"
          disabled={disabled || !name.trim()}
        >
          Create
        </button>
        <button
          type="button"
          className="workspace-sidebar__button"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

export const WorkspaceSidebar = ({
  workspace,
  dirty,
  busy,
  disabled,
  fileName,
  onAddCollection,
  onAddCanvas,
  onSelectCanvas,
  onSave,
  onOpen,
}: WorkspaceSidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [closedCollections, setClosedCollections] = useState<Set<string>>(
    new Set(),
  );
  const [adding, setAdding] = useState<
    { type: "collection" } | { type: "canvas"; collectionId: string } | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const unavailable = disabled || busy || !workspace;

  useEffect(() => {
    if (!adding && triggerRef.current) {
      triggerRef.current.ownerDocument
        .getElementById(triggerRef.current.id)
        ?.focus();
    }
  }, [adding]);

  const closeForm = () => {
    setAdding(null);
  };

  return (
    <aside
      className={`workspace-sidebar${
        collapsed ? " workspace-sidebar--collapsed" : ""
      }`}
      aria-label="Workspace"
      aria-busy={busy}
    >
      <div className="workspace-sidebar__header">
        <h2 hidden={collapsed}>Workspace</h2>
        <button
          type="button"
          className="workspace-sidebar__button workspace-sidebar__toggle"
          aria-label={collapsed ? "Show workspace" : "Hide workspace"}
          title={collapsed ? "Show workspace" : "Hide workspace"}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span aria-hidden="true">{chevronLeftIcon}</span>
        </button>
      </div>
      <div
        id={panelId}
        className="workspace-sidebar__contents"
        hidden={collapsed}
      >
        <nav
          className="workspace-sidebar__collections"
          aria-label="Collections and canvases"
        >
          <div className="workspace-sidebar__section-label">Collections</div>
          <ul className="workspace-sidebar__list">
            {workspace?.collections.map((collection) => {
              const expanded = !closedCollections.has(collection.id);
              const collectionPanelId = `${panelId}-${collection.id}`;

              return (
                <li
                  key={collection.id}
                  className="workspace-sidebar__collection"
                >
                  <button
                    type="button"
                    className="workspace-sidebar__button workspace-sidebar__collection-button"
                    aria-expanded={expanded}
                    aria-controls={collectionPanelId}
                    title={collection.name}
                    onClick={() => {
                      setClosedCollections((current) => {
                        const next = new Set(current);
                        if (expanded) {
                          next.add(collection.id);
                        } else {
                          next.delete(collection.id);
                        }
                        return next;
                      });
                    }}
                  >
                    <span aria-hidden="true">
                      {expanded ? chevronDownIcon : chevronRight}
                    </span>
                    <span aria-hidden="true">{LoadIcon}</span>
                    <span className="workspace-sidebar__name">
                      {collection.name}
                    </span>
                  </button>
                  <div id={collectionPanelId} hidden={!expanded}>
                    <ul className="workspace-sidebar__list workspace-sidebar__canvases">
                      {collection.canvases.map((canvas) => (
                        <li key={canvas.id}>
                          <button
                            type="button"
                            className="workspace-sidebar__button workspace-sidebar__canvas"
                            aria-current={
                              canvas.id === workspace.activeCanvasId
                                ? "page"
                                : undefined
                            }
                            title={canvas.name}
                            disabled={unavailable}
                            onClick={() => onSelectCanvas(canvas.id)}
                          >
                            <span aria-hidden="true">{file}</span>
                            <span className="workspace-sidebar__name">
                              {canvas.name}
                            </span>
                          </button>
                        </li>
                      ))}
                      <li>
                        {adding?.type === "canvas" &&
                        adding.collectionId === collection.id ? (
                          <NameForm
                            label="Canvas name"
                            disabled={unavailable}
                            onCreate={(name) => {
                              onAddCanvas(collection.id, name);
                              closeForm();
                            }}
                            onCancel={closeForm}
                          />
                        ) : (
                          <button
                            id={`${collectionPanelId}-add`}
                            type="button"
                            className="workspace-sidebar__button workspace-sidebar__add"
                            disabled={unavailable}
                            aria-label={`Add canvas to ${collection.name}`}
                            onClick={(event) => {
                              triggerRef.current = event.currentTarget;
                              setAdding({
                                type: "canvas",
                                collectionId: collection.id,
                              });
                            }}
                          >
                            <span aria-hidden="true">{PlusIcon}</span>
                            Add canvas
                          </button>
                        )}
                      </li>
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
          {adding?.type === "collection" ? (
            <NameForm
              label="Collection name"
              disabled={unavailable}
              onCreate={(name) => {
                onAddCollection(name);
                closeForm();
              }}
              onCancel={closeForm}
            />
          ) : (
            <button
              id={`${panelId}-new`}
              type="button"
              className="workspace-sidebar__button workspace-sidebar__new-collection"
              disabled={unavailable}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setAdding({ type: "collection" });
              }}
            >
              <span aria-hidden="true">{PlusIcon}</span>
              New collection
            </button>
          )}
        </nav>
        <div className="workspace-sidebar__storage">
          <div
            className="workspace-sidebar__file"
            title={fileName || undefined}
          >
            {fileName || "Local workspace"}
          </div>
          <div className="workspace-sidebar__save-status" role="status">
            {dirty
              ? "Unsaved changes"
              : fileName
              ? "Saved to disk"
              : "Not saved to disk"}
          </div>
          <button
            type="button"
            className="workspace-sidebar__button workspace-sidebar__button--primary"
            disabled={unavailable}
            onClick={onSave}
          >
            <span aria-hidden="true">{save}</span>
            Save workspace
          </button>
          <button
            type="button"
            className="workspace-sidebar__button"
            disabled={unavailable}
            onClick={onOpen}
          >
            <span aria-hidden="true">{LoadIcon}</span>
            Open workspace
          </button>
        </div>
      </div>
    </aside>
  );
};
