import { newElement, newImageElement } from "@excalidraw/element";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import {
  createCanvas,
  createCollection,
  createWorkspace,
  parseWorkspace,
  serializeWorkspace,
  snapshotScene,
} from "./workspace";

const fileId = "image-file" as FileId;
const files: BinaryFiles = {
  [fileId]: {
    id: fileId,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" as DataURL,
    created: 123,
  },
};
const image = newImageElement({
  type: "image",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fileId,
  status: "saved",
});
const rectangle = newElement({
  type: "rectangle",
  x: 20,
  y: 30,
  width: 80,
  height: 60,
});

describe("workspace files", () => {
  it("round trips full app state when both arrowheads are set to none", () => {
    const workspace = createWorkspace(
      snapshotScene(
        [rectangle],
        {
          ...getDefaultAppState(),
          currentItemStartArrowhead: null,
          currentItemEndArrowhead: null,
          name: null,
          fontTopPicks: null,
          originSnapOffset: null,
        },
        {},
      ),
    );
    const reopened = parseWorkspace(serializeWorkspace(workspace));
    expect(reopened.collections[0].canvases[0].scene.appState).toMatchObject({
      currentItemStartArrowhead: null,
      currentItemEndArrowhead: null,
      name: null,
      fontTopPicks: null,
    });
  });

  it("round trips all collections, canvas contents, viewport, and image bytes", () => {
    const workspace = createWorkspace(
      snapshotScene([image, rectangle], { scrollX: 31, scrollY: -42 }, files),
    );
    workspace.collections[0].name = "HexaVision";
    workspace.collections[0].canvases[0].name = "DB Design";
    workspace.collections[0].canvases.push(createCanvas("API Schema"));
    const interview = createCollection("Interview Prep");
    interview.canvases.push(
      createCanvas("DSA", snapshotScene([rectangle], {}, {})),
    );
    workspace.collections.push(interview);
    workspace.activeCanvasId = interview.canvases[0].id;

    const reopened = parseWorkspace(serializeWorkspace(workspace));
    expect(reopened.activeCanvasId).toBe(workspace.activeCanvasId);
    expect(reopened.collections.map(({ name }) => name)).toEqual([
      "HexaVision",
      "Interview Prep",
    ]);
    expect(reopened.collections[0].canvases.map(({ name }) => name)).toEqual([
      "DB Design",
      "API Schema",
    ]);
    const scene = reopened.collections[0].canvases[0].scene;
    expect(scene.elements.map(({ id }) => id)).toEqual([
      image.id,
      rectangle.id,
    ]);
    expect(scene.appState).toMatchObject({ scrollX: 31, scrollY: -42 });
    expect(scene.files).toEqual(files);
    expect(reopened.collections[0].canvases[1].scene.elements).toEqual([]);
    expect(reopened.collections[1].canvases[0].scene.elements[0].id).toBe(
      rectangle.id,
    );
    expect(reopened.collections[1].canvases[0].scene.files).toEqual({});
  });

  it("takes detached snapshots and removes interaction state and unused assets", () => {
    const selectedElementIds = { [rectangle.id]: true as const };
    const scene = snapshotScene(
      [rectangle, { ...image, isDeleted: true }],
      {
        scrollX: 25,
        selectedElementIds,
        collaborators: new Map(),
        openDialog: { name: "help" },
        errorMessage: "temporary error",
      },
      files,
    );
    expect(scene.elements).toEqual([rectangle]);
    expect(scene.elements[0]).not.toBe(rectangle);
    expect(scene.appState).toEqual({ scrollX: 25 });
    expect(scene.files).toEqual({});
    expect(selectedElementIds).toEqual({ [rectangle.id]: true });
  });

  it("refuses to export an image without its embedded file", () => {
    const workspace = createWorkspace(snapshotScene([image], {}, {}));
    expect(() => serializeWorkspace(workspace)).toThrow(
      "An image has not finished loading",
    );
  });

  it.each(["not json", "null", "[]", '{"type":"excalidraw"}'])(
    "rejects invalid envelopes: %s",
    (json) => {
      expect(() => parseWorkspace(json)).toThrow(
        "not a valid Excalidraw workspace",
      );
    },
  );

  it("rejects unsupported versions", () => {
    expect(() =>
      parseWorkspace(JSON.stringify({ ...createWorkspace(), version: 2 })),
    ).toThrow("version is not supported");
  });

  it("rejects duplicate canvas IDs and nonexistent active canvas IDs", () => {
    const workspace = createWorkspace();
    const other = createCollection("Other");
    other.canvases.push(workspace.collections[0].canvases[0]);
    workspace.collections.push(other);
    expect(() => parseWorkspace(JSON.stringify(workspace))).toThrow();
    workspace.collections.pop();
    workspace.activeCanvasId = "missing";
    expect(() => parseWorkspace(JSON.stringify(workspace))).toThrow();
  });

  it("rejects corrupt scenes before replacing any workspace", () => {
    const workspace = createWorkspace(snapshotScene([image], {}, files));
    const valid = JSON.stringify(workspace);
    const corruptions = [
      (scene: any) => (scene.elements = [null]),
      (scene: any) => (scene.elements[0].type = "unsupported"),
      (scene: any) => (scene.elements[0].x = "invalid"),
      (scene: any) => (scene.files = {}),
      (scene: any) => (scene.files[fileId].dataURL = "https://external/image"),
      (scene: any) => (scene.appState.scrollX = "invalid"),
      (scene: any) => (scene.appState.activeTool = null),
      (scene: any) => (scene.appState.gridSize = null),
      (scene: any) => (scene.appState.scrollY = null),
      (scene: any) => (scene.appState.currentItemEndArrowhead = 10),
      (scene: any) => (scene.appState.zoom = { value: -1 }),
    ];
    for (const corrupt of corruptions) {
      const candidate = JSON.parse(valid);
      corrupt(candidate.collections[0].canvases[0].scene);
      expect(() => parseWorkspace(JSON.stringify(candidate))).toThrow(
        "not a valid Excalidraw workspace",
      );
    }
    expect(() => parseWorkspace(valid)).not.toThrow();
  });

  it("permits an empty collection without inventing canvases", () => {
    const workspace = createWorkspace();
    workspace.collections = [createCollection("Empty collection")];
    workspace.activeCanvasId = null;
    expect(
      parseWorkspace(serializeWorkspace(workspace)).collections[0],
    ).toEqual(workspace.collections[0]);
  });
});
