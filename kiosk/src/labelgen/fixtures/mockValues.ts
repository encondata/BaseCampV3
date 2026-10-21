/**
 * Test fixture: fields.py `MOCK_VALUES`, copied verbatim (one fixed sample
 * per builder field). vegas_v2_300.zpl is compiled from these values.
 * Task 3 ports fields.py itself; this copy only feeds the compiler tests.
 */

export const MOCK_VALUES: Readonly<Record<string, string>> = {
    // Asset
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "rfid_tag": "000000000000000000100000",
    "pod_number": "P4",
    "asset_status": "Racked",
    "has_rails": "Yes",
    "location_detail": "F01 U18",
    // Make & model
    "make_model": "Dell PowerEdge R740",
    // On this move
    "source_rack": "09.01.05D.02.10",
    "source_ru": "12",
    "source_position": "Front",
    "source_pod": "P4",
    "destination_rack": "14.01.07C.02.03",
    "destination_ru": "12",
    "destination_position": "Front",
    "destination_pod": "D4",
    "priority_wave": "Wave 1",
    "disposition": "Relocate",
    "owner": "Data Services",
    "cable_data_1": "SW01/01",
    "cable_data_2": "SW01/02",
    "cable_data_3": "SW01/03",
    "cable_data_4": "SW01/04",
    "cable_data_5": "SW01/05",
    "cable_data_6": "SW01/06",
    "cable_mgmt_1": "MGMT01/01",
    "cable_mgmt_2": "MGMT01/02",
    "vendor_involved": "No",
    "roster_status": "Labeled",
    // Move
    "move_name": "Sample Move",
    "move_code": "SMPL",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    // Sites
    "origin_site_name": "Sample Site A",
    "origin_site_code": "SITE-A",
    "destination_site_name": "Sample Site B",
    "destination_site_code": "SITE-B",
    // Container
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
    "container_rfid_tag": "000000000000000000200000",
    "container_type": "D-container",
    "container_status": "Available",
    // Person (an ID badge): a plausible worker
    "person_name": "Jordan Rivera",
    "first_name": "Jordan",
    "last_name": "Rivera",
    "preferred_name": "Jordan",
    "person_type": "Worker",
    "company": "Rivera Electric",
    "parent_company": "Rivera Holdings",
    "job_title": "Lead Electrician",
    "roles": "Admin, Staff",
    "trade": "Electrician",
    "level": "L3 Technician",
    "worker_status": "Active",
    "employee_id": "E-10482",
    "email": "jordan.rivera@example.com",
    "phone": "(555) 010-4821",
    "person_rfid_tag": "100418",
    "badge_id": "3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b",
    "badge_short": "3f2a9c1e",
};
