import { HelloRecord, Repository, Revision } from './contracts';
import { validateId, validateRecord, validateRevision } from './schema';
export class HelloWorld {
  constructor(private readonly repository: Repository<HelloRecord>) {}
  async read(id: string) { validateId(id); return this.repository.read(id); }
  async add(record: HelloRecord) { return this.repository.add(validateRecord(record)); }
  async write(record: HelloRecord, expectedRevision: Revision) {
    const valid = validateRecord(record); validateRevision(expectedRevision);
    return this.repository.write(valid, expectedRevision);
  }
}
