import fs from "node:fs";
import path from "node:path";
import { contractOperationBlock, contractResponseCodes, inlineLists, schemaBlock } from "../../helpers/contract";
import { FEE_AMOUNT_MAX } from "../../../src/app/doctors/constants";

describe("availability slice 1 contract (C1-C3)", () => {
    const block = contractOperationBlock("/api/doctors/{doctorUserId}/slots", "get");
    it("should declare the patient and admin slots operation with the exact response set", () => {
        expect(block).toContain("operationId: getDoctorSlots");
        expect(inlineLists(block, "x-roles")).toEqual([["patient", "admin"]]);
        expect(block).toContain("x-ownership: none");
        expect(block).toContain("bearerUser");
        expect([...contractResponseCodes("/api/doctors/{doctorUserId}/slots", "get")].sort()).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
    });
    it("should describe 404, 14-day validation, clipping, and start-only inclusion", () => {
        for (const phrase of ["non-bookable doctor", "another", "404 NotFound", "at most 14 days", "[now, now + 60 days]", "data: []", "start lies", "IANA zone"]) {
            expect(block).toContain(phrase);
        }
    });
    it("should describe effective window metadata and inactive or foreign types", () => {
        const meta = schemaBlock("SlotWindowMeta");
        expect(meta).toContain("nearest bound");
        expect(meta.match(/nearest bound/g)).toHaveLength(2);
        const yaml = fs.readFileSync(path.resolve(__dirname, "../../../contracts/openapi.yaml"), "utf8");
        expect(yaml.match(/A type that is unknown, inactive, deleted or another doctor's is `404 NotFound`/g)).toHaveLength(1);
        expect(schemaBlock("Slot")).toContain("startsAtLocal");
    });
});

describe("availability slice 2 contract (C4-C8)", () => {
    const yaml = fs.readFileSync(path.resolve(__dirname, "../../../contracts/openapi.yaml"), "utf8");
    const parameter = (name: string): string => {
        const start = yaml.indexOf(`\n    ${name}:\n      name:`);
        expect(start).toBeGreaterThan(0);
        const rest = yaml.slice(start + 1);
        const end = rest.slice(5).search(/\n {4}\S/);
        return rest.slice(0, end < 0 ? rest.length : end + 5);
    };
    const search = contractOperationBlock("/api/doctors", "get");
    const profile = contractOperationBlock("/api/doctors/{doctorUserId}", "get");

    it("should declare searchDoctors for patients and admins with the exact response set", () => {
        expect(search).toContain("operationId: searchDoctors");
        expect(inlineLists(search, "x-roles")).toEqual([["patient", "admin"]]);
        expect(search).toContain("x-ownership: none");
        expect(search).toContain("bearerUser");
        expect([...contractResponseCodes("/api/doctors", "get")].sort()).toEqual(["200", "400", "401", "403", "429", "500"]);
    });
    it("should describe the derived index, degradation, fee and cursor rules (C4)", () => {
        for (const phrase of ["derived Redis index", "120 s sweep", "`meta.degraded`", "currency is not compared", "`minFee > maxFee` is `400`", "restart the list without a cursor", "60/min per IP and 120/min per user"]) {
            expect(search).toContain(phrase);
        }
        expect(search).not.toContain("next-available` Redis cache");
    });
    it("should declare meta.degraded with the three-part enum (C5)", () => {
        expect(search).toContain("allOf:");
        expect(search).toContain("uniqueItems: true");
        expect(inlineLists(search, "enum")).toContainEqual(["sort", "availabilityFilter", "nameFilter"]);
    });
    it("should describe the sort, name, fee and window parameters (C6)", () => {
        const sort = parameter("SearchSort");
        expect(sort).toContain("earliest_availability: earliest free slot first");
        expect(sort).toContain("default: earliest_availability");
        expect(inlineLists(sort, "enum")).toEqual([["earliest_availability", "price", "experience"]]);
        expect(parameter("NameFilter")).toContain("`meta.degraded` contains `nameFilter`");
        expect(parameter("NameFilter")).toContain("Control characters are rejected");
        expect(parameter("NameFilter")).toContain("up to about 11 minutes");
        expect(parameter("NameFilter")).toContain("at least 2 code points must remain after trimming");
        for (const name of ["MinFee", "MaxFee"]) expect(parameter(name)).toContain("currency is ignored");
        for (const name of ["MinFee", "MaxFee"]) {
            expect(parameter(name)).toContain("minimum: 0");
            expect(parameter(name)).toContain(`maximum: ${FEE_AMOUNT_MAX}`);
        }
        expect(parameter("SpecialtyFilter")).toContain("minLength: 1");
        expect(parameter("SpecialtyFilter")).toContain("maxLength: 100");
        for (const name of ["AvailableFrom", "AvailableTo"]) {
            expect(parameter(name)).toContain("`[availableFrom, availableTo)`");
            expect(parameter(name)).toContain("Matching is exact to 15 minutes");
        }
    });
    it("should describe the public DoctorProfile fields (C7)", () => {
        const doctor = schemaBlock("DoctorProfile");
        for (const phrase of ["shortest active consultation type", "up to one sweep", "Active types only.", "first 5 free slots", "empty for a non-bookable doctor", "for an admin caller"]) {
            expect(doctor).toContain(phrase);
        }
    });
    it("should declare getDoctor with IANA validation and a bounded timezone (C8)", () => {
        expect(profile).toContain("operationId: getDoctor");
        expect(inlineLists(profile, "x-roles")).toEqual([["patient", "admin"]]);
        expect(profile).toContain("x-ownership: none");
        expect(profile).toContain("Rate limit 60/min per IP and 120/min per user");
        expect(profile).toContain("IANA zone");
        expect(profile).toContain("maxLength: 64");
        expect([...contractResponseCodes("/api/doctors/{doctorUserId}", "get")].sort()).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
        expect(parameter("SlotTimezone")).toContain("maxLength: 64");
    });
});
