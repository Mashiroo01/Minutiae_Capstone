<?php
/**
 * POLICE CLEARANCE SYSTEM - TWO-STEP VERIFICATION EXAMPLE
 * 
 * This demonstrates the new workflow:
 * 1. Applicant enters: Name, Age, Sex
 * 2. System searches for demographic match (HIT check)
 * 3. If HIT found, applicant scans fingerprint
 * 4. System compares fingerprints using Bozorth3
 * 5. Clearance decision: APPROVE or REJECT
 */

require_once 'backend/applicant_info.php';
require_once 'backend/FingerprintDB.php';

echo "════════════════════════════════════════════════════════════════\n";
echo "    MINUTIAE - POLICE CLEARANCE SYSTEM\n";
echo "    Two-Step Verification Process\n";
echo "════════════════════════════════════════════════════════════════\n\n";

// =====================================================================
// EXAMPLE 1: Subject with NO Criminal Record
// =====================================================================

echo "EXAMPLE 1: Clean Record\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "Applicant: Margaret Johnson, Age 28, Female\n\n";

echo "STEP 1: Demographic Search\n";
echo "  Searching for: Name='Margaret Johnson', Age=28, Sex='F'\n";
echo "  Database search...\n";
echo "  Result: ❌ NO MATCH FOUND\n\n";

echo "DECISION:\n";
echo "  ✅ CLEARANCE: APPROVED\n";
echo "  Risk Level: LOW\n";
echo "  Reason: No criminal record with matching demographics\n";
echo "  Action: Continue with normal application process\n\n";

echo "\nJSON Response:\n";
$example1 = [
    'success' => true,
    'overall_risk' => 'low',
    'recommendation' => 'APPROVE',
    'message' => 'No matching criminal records found. Clearance APPROVED.',
    'demographic_match_found' => false,
    'fingerprint_scan_required' => false
];
echo json_encode($example1, JSON_PRETTY_PRINT) . "\n\n";

// =====================================================================
// EXAMPLE 2: Demographic Match BUT Different Person
// =====================================================================

echo "═════════════════════════════════════════════════════════════════\n";
echo "EXAMPLE 2: Same Name, Different Person\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "Applicant: Robert Miller, Age 35, Male\n";
echo "Criminal on File: Robert Miller, Age 35, Male (CASE-2021-447)\n\n";

echo "STEP 1: Demographic Search\n";
echo "  Searching for: Name='Robert Miller', Age=35, Sex='M'\n";
echo "  Database search...\n";
echo "  Result: ✅ MATCH FOUND - Criminal record exists!\n";
echo "  Proceeding to fingerprint verification...\n\n";

echo "STEP 2: Fingerprint Verification\n";
echo "  Requesting applicant's fingerprint...\n";
echo "  Applicant scans right index finger\n";
echo "  Running Bozorth3 comparison...\n";
echo "  Fingerprint Score: 18 (No Match)\n\n";

echo "ANALYSIS:\n";
echo "  • Score 18 < Threshold 40: Different person\n";
echo "  • Same name and age but different biometrics\n";
echo "  • Conclusion: NOT the same person\n\n";

echo "DECISION:\n";
echo "  ✅ CLEARANCE: APPROVED (with caution)\n";
echo "  Risk Level: LOW\n";
echo "  Reason: Demographic match found but fingerprint does NOT match\n";
echo "  Action: Approve with flag for manual review\n\n";

echo "\nJSON Response:\n";
$example2 = [
    'success' => true,
    'overall_risk' => 'low',
    'recommendation' => 'APPROVED_WITH_CAUTION',
    'message' => 'Demographic hit found but no fingerprint match. Clearance APPROVED with caution.',
    'demographic_match_found' => true,
    'fingerprint_scan_required' => true,
    'fingerprint_match_found' => false,
    'matching_criminals' => [
        [
            'name' => 'Robert Miller',
            'age' => 35,
            'sex' => 'M',
            'case_number' => 'CASE-2021-447'
        ]
    ],
    'fingerprint_score' => 18
];
echo json_encode($example2, JSON_PRETTY_PRINT) . "\n\n";

// =====================================================================
// EXAMPLE 3: Match Confirmed - REJECTION
// =====================================================================

echo "═════════════════════════════════════════════════════════════════\n";
echo "EXAMPLE 3: ALERT - Same Person Identified!\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "Applicant: Patricia Williams, Age 32, Female\n";
echo "Criminal on File: Patricia Williams, Age 32, Female (CASE-2019-823)\n\n";

echo "STEP 1: Demographic Search\n";
echo "  Searching for: Name='Patricia Williams', Age=32, Sex='F'\n";
echo "  Database search...\n";
echo "  Result: ✅ MATCH FOUND - Criminal record exists!\n";
echo "  Proceeding to fingerprint verification...\n\n";

echo "STEP 2: Fingerprint Verification\n";
echo "  Requesting applicant's fingerprint...\n";
echo "  Applicant scans right index finger\n";
echo "  Running Bozorth3 comparison...\n";
echo "  Fingerprint Score: 54 (MATCH!)\n\n";

echo "ALERT:\n";
echo "  ⚠️  Score 54 > Threshold 40: FINGERPRINT MATCH CONFIRMED\n";
echo "  ⚠️  BIOMETRIC VERIFICATION: SAME PERSON IDENTIFIED\n";
echo "  ⚠️  CRIMINAL RECORD: CASE-2019-823\n\n";

echo "DECISION:\n";
echo "  ❌ CLEARANCE: REJECTED\n";
echo "  Risk Level: HIGH\n";
echo "  Reason: APPLICANT IS THE CRIMINAL ON FILE\n";
echo "  Action: AUTO-REJECT, Escalate to authorities\n\n";

echo "\nJSON Response:\n";
$example3 = [
    'success' => true,
    'overall_risk' => 'high',
    'recommendation' => 'REJECT',
    'message' => 'FINGERPRINT MATCH DETECTED! Clearance REJECTED.',
    'demographic_match_found' => true,
    'fingerprint_scan_required' => true,
    'fingerprint_match_found' => true,
    'matching_criminals' => [
        [
            'name' => 'Patricia Williams',
            'age' => 32,
            'sex' => 'F',
            'case_number' => 'CASE-2019-823'
        ]
    ],
    'fingerprint_score' => 54,
    'action' => 'REJECT_AND_ESCALATE'
];
echo json_encode($example3, JSON_PRETTY_PRINT) . "\n\n";

// =====================================================================
// SYSTEM FLOW CHART
// =====================================================================

echo "═════════════════════════════════════════════════════════════════\n";
echo "SYSTEM WORKFLOW\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "┌──────────────────────────────────────────────────────────┐\n";
echo "│  STEP 1: APPLICANT SUBMITS                               │\n";
echo "│  Name, Age, Sex, Email, Fingerprint (optional at this    │\n";
echo "│  point - only required if demographic hit found)         │\n";
echo "└──────────────────┬───────────────────────────────────────┘\n";
echo "                   │\n";
echo "                   ▼\n";
echo "┌──────────────────────────────────────────────────────────┐\n";
echo "│  STEP 2: DEMOGRAPHIC MATCH CHECK (HIT Check)            │\n";
echo "│  Search Criminal Database for:                           │\n";
echo "│  Name AND Age AND Sex (all three must match)             │\n";
echo "└──────────────────┬───────────────────────────────────────┘\n";
echo "                   │\n";
echo "         ┌─────────┴──────────┐\n";
echo "         │                    │\n";
echo "         ▼                    ▼\n";
echo "  ┌─────────────┐       ┌──────────────┐\n";
echo "  │  NO MATCH   │       │   HIT FOUND  │\n";
echo "  │ Found       │       │ Found        │\n";
echo "  └──────┬──────┘       └──────┬───────┘\n";
echo "         │                     │\n";
echo "         │                     ▼\n";
echo "         │          ┌─────────────────────┐\n";
echo "         │          │  STEP 3: FINGERPRINT│\n";
echo "         │          │  VERIFICATION       │\n";
echo "         │          │  Scan applicant     │\n";
echo "         │          │  Compare with       │\n";
echo "         │          │  criminal's print   │\n";
echo "         │          │  (Bozorth3)         │\n";
echo "         │          └──────────┬──────────┘\n";
echo "         │                     │\n";
echo "         │          ┌──────────┴──────────┐\n";
echo "         │          │                     │\n";
echo "         │          ▼                     ▼\n";
echo "         │     ┌──────────┐          ┌──────────┐\n";
echo "         │     │  NO      │          │  MATCH   │\n";
echo "         │     │  MATCH   │          │  FOUND   │\n";
echo "         │     │ Score<40 │          │ Score>40 │\n";
echo "         │     └────┬─────┘          └────┬─────┘\n";
echo "         │          │                     │\n";
echo "    ┌────▼──────────▼─────┐          ┌────▼─────────┐\n";
echo "    │  APPROVED            │          │  REJECTED    │\n";
echo "    │ (Different person)   │          │ (Same person)│\n";
echo "    │                      │          │              │\n";
echo "    │  ✅ PROCEED          │          │  ❌ DENY     │\n";
echo "    └──────────────────────┘          └──────────────┘\n\n";

// =====================================================================
// API USAGE
// =====================================================================

echo "═════════════════════════════════════════════════════════════════\n";
echo "API USAGE\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "1. SUBMIT APPLICANT\n";
echo "   POST /backend/applicant_info.php?action=submit\n\n";
echo "   Request:\n";
echo "   {\n";
echo "     \"name\": \"John Doe\",\n";
echo "     \"age\": 30,\n";
echo "     \"sex\": \"M\",\n";
echo "     \"email\": \"john@example.com\",\n";
echo "     \"fingerprints\": {\n";
echo "       \"index_right\": {\n";
echo "         \"template\": \"binary_data\",\n";
echo "         \"quality\": 85\n";
echo "       }\n";
echo "     }\n";
echo "   }\n\n";

echo "2. PERFORM BACKGROUND CHECK (Two-Step Verification)\n";
echo "   POST /backend/applicant_info.php?action=check\n\n";
echo "   Request:\n";
echo "   {\n";
echo "     \"applicant_id\": 1,\n";
echo "     \"name\": \"John Doe\",\n";
echo "     \"age\": 30,\n";
echo "     \"sex\": \"M\"\n";
echo "   }\n\n";
echo "   Response shows:\n";
echo "   - Step 1 results (demographic match or not)\n";
echo "   - Step 2 results (fingerprint match if step 1 hit)\n";
echo "   - Overall decision (APPROVE or REJECT)\n\n";

// =====================================================================
// KEY POINTS
// =====================================================================

echo "═════════════════════════════════════════════════════════════════\n";
echo "KEY POINTS\n";
echo "─────────────────────────────────────────────────────────────────\n\n";

echo "✅ DEMOGRAPHIC MATCH (HIT CHECK)\n";
echo "   - Searches by: Name + Age + Sex\n";
echo "   - All three must match\n";
echo "   - Quick first-pass screening\n";
echo "   - No fingerprint required if no match\n\n";

echo "✅ FINGERPRINT VERIFICATION\n";
echo "   - Only performed if demographic HIT found\n";
echo "   - Uses Bozorth3 NIST algorithm\n";
echo "   - Score >= 40 = MATCH (same person)\n";
echo "   - Score < 40 = NO MATCH (different person)\n\n";

echo "✅ CLEARANCE OUTCOMES\n";
echo "   - APPROVED: No criminal record found\n";
echo "   - APPROVED_WITH_CAUTION: Name match but different person\n";
echo "   - REJECTED: Fingerprint match (same person confirmed)\n\n";

echo "✅ AUDIT TRAIL\n";
echo "   - All checks logged\n";
echo "   - All scores recorded\n";
echo "   - Contact with criminal database tracked\n";
echo "   - Compliance-ready\n\n";

echo "═════════════════════════════════════════════════════════════════\n";
echo "For full documentation, see: POLICE_CLEARANCE_WORKFLOW.md\n";
echo "═════════════════════════════════════════════════════════════════\n";
?>
