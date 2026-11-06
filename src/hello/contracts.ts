export interface HelloRecord { id: string; message: string }
export type Revision = string;
export interface Stored<T> { record: T; revision: Revision }
export interface Repository<T extends { id: string }> {
  read(id: string): Promise<Stored<T> | null>;
  add(record: T): Promise<Stored<T>>;
  write(record: T, expectedRevision: Revision): Promise<Stored<T>>;
}
export class RepositoryError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'RepositoryError'; }
}
