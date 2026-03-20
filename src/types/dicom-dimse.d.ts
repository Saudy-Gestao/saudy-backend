declare module 'dicom-dimse' {
  export class DimseScp {
    constructor(options: { port: number; aeTitle: string; verbose?: boolean });
    on(event: string, handler: (request: any, callback: (error: any, result?: any) => void) => void): void;
    listen(): void;
    close(): void;
  }
}