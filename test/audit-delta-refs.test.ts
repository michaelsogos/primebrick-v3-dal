import { describe, it, expect, beforeEach } from "vitest";
import { Column, Entity, Ref, Unique } from "../src/meta/entity-decorators.js";
import { configureSchemaDomain, resetSchemaDomain } from "../src/meta/schema-domain.js";
import { registerEntityService } from "../src/entity/entity-registry.js";
import { enrichAuditDeltaRefs } from "../src/entity/audit-delta-refs.js";
import { UserProfileRefEntity } from "../src/entities/user-profile-ref-entity.js";
import { ServiceRegistryRefEntity } from "../src/entities/service-registry-ref-entity.js";

@Entity("customers", "job")
class CustomerEntity {
  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: string;

  name!: string;
}

@Entity("job_triggers", "job")
class JobTriggerTestEntity {
  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: string;

  @Ref("user_profile")
  updated_by!: string | null;

  @Ref("customer")
  customer_uuid!: string | null;

  note!: string | null;
}

const USER_UUID = "11111111-1111-4111-8111-111111111111";
const PREV_USER_UUID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_UUID = "33333333-3333-4333-8333-333333333333";

const FIND_RESULTS = new Map<unknown, Record<string, unknown>[]>([
  [
    UserProfileRefEntity,
    [
      { uuid: USER_UUID, display_name: "Micha Sogos" },
      { uuid: PREV_USER_UUID, display_name: "Old Admin" },
    ],
  ],
  [ServiceRegistryRefEntity, [{ code: "emailsender", name: "Email Sender" }]],
  [CustomerEntity, [{ uuid: CUSTOMER_UUID, name: "Acme" }]],
]);

const repo = {
  findAll: async (entity: unknown) => FIND_RESULTS.get(entity) ?? [],
};

describe("enrichAuditDeltaRefs", () => {
  beforeEach(() => {
    resetSchemaDomain();
    configureSchemaDomain(["job"]);
    registerEntityService({ entity: CustomerEntity, display: "${name}" });
  });

  it("resolves *_by actor uuids per-side (old actor ≠ new actor)", async () => {
    const [out] = await enrichAuditDeltaRefs(repo as never, JobTriggerTestEntity, [
      { updated_by: { old: PREV_USER_UUID, new: USER_UUID } },
    ]);
    const ch = out!.updated_by as Record<string, unknown>;
    expect(ch.old_display_name).toBe("Old Admin");
    expect(ch.new_display_name).toBe("Micha Sogos");
  });

  it("resolves system:<code> actors through service_registry", async () => {
    const [out] = await enrichAuditDeltaRefs(repo as never, JobTriggerTestEntity, [
      { updated_by: { old: null, new: "system:emailsender" } },
    ]);
    const ch = out!.updated_by as Record<string, unknown>;
    expect(ch.new_display_name).toBe("Email Sender");
  });

  it("resolves domain @Ref columns via the entity registry display template", async () => {
    const [out] = await enrichAuditDeltaRefs(repo as never, JobTriggerTestEntity, [
      { customer_uuid: { old: null, new: CUSTOMER_UUID } },
    ]);
    const ch = out!.customer_uuid as Record<string, unknown>;
    expect(ch.new_display_name).toBe("Acme");
  });

  it("leaves non-ref fields and unresolved uuids untouched", async () => {
    const [out] = await enrichAuditDeltaRefs(repo as never, JobTriggerTestEntity, [
      {
        note: { old: "a", new: "b" },
        customer_uuid: { old: null, new: "99999999-9999-4999-8999-999999999999" },
      },
    ]);
    const note = out!.note as Record<string, unknown>;
    expect(note.old_display_name).toBeUndefined();
    const ch = out!.customer_uuid as Record<string, unknown>;
    expect(ch.new_display_name).toBeUndefined();
  });
});
