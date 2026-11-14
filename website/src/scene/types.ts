/** Scroll-derived inputs the stage reads every frame. All values are plain numbers. */
export interface StageInput {
  /** Scene timeline: 0 hero, 1 groups, 2 story start, 3 story end, 3.1 steps gone, 3.5 attention, 4 download. */
  timeline: number;
  /** Progress through the five brain-and-workers steps, 0..1. */
  story: number;
  /** Visibility of the needs-attention section, 0..1. */
  attention: number;
  /** Pointer position in -1..1 on both axes. */
  pointerX: number;
  pointerY: number;
}

export interface Stage {
  update(input: StageInput, dt: number): void;
  resize(width: number, height: number): void;
  /** Opacity the canvas should be shown at for the current timeline position. */
  readonly opacity: number;
  dispose(): void;
}

export interface StageOptions {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  reducedMotion: boolean;
}
