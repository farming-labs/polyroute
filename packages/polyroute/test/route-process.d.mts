export function createRouteProcess(): {
  load(file: string): Promise<unknown>;
  close(): Promise<void>;
};
