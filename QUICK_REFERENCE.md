# Police Clearance - Quick Reference Guide

## System Architecture

```
┌─────────────────────────────────────┐
│  Applicant Submission               │
│  Name, Age, Sex, Fingerprint        │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  DATABASE: Store Applicant          │
│  applicants table                   │
│  - applicant_id (auto)              │
│  - name, age, sex                   │
│  - clearance_status = 'PENDING'     │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  STEP 1: Demographic Check          │
│  Query: SELECT * FROM criminal_      │
│  records WHERE name = ? AND          │
│  age = ? AND sex = ?                 │
└────────────┬────────────────────────┘
             │
     ┌───────┴──────────┐
     │                  │
  ┌──▼──┐            ┌──▼──┐
  │ NO  │            │ YES │
  │ HIT │            │ HIT │
  └──┬──┘            └──┬──┘
     │                  │
     │                  ▼
     │        ┌──────────────────────┐
     │        │ STEP 2: Fingerprint  │
     │        │ Comparison           │
     │        │ (Bozorth3)           │
     │        │ Get applicant FP     │
     │        │ Get criminal FP      │
     │        │ Compare score        │
     │        └──────┬───────────────┘
     │               │
     │        ┌──────┴────────┐
     │        │               │
     │      ┌─▼─┐           ┌─▼─┐
     │      │NO │           │YES│
     │      └─┬─┘           └─┬─┘
     │        │               │
  ┌──▼────────▼──┐        ┌───▼────────┐
  │ APPROVED or  │        │  REJECTED  │
  │ APPROVED WITH│        │            │
  │ CAUTION      │        │ ❌ DENY    │
  │              │        │            │
  │ ✅ UPDATE:   │        │ ✅ UPDATE: │
  │ 'APPROVED'   │        │ 'REJECTED' │
  │ or           │        │            │
  │ 'APPROVED_   │        │ Escalate   │
  │ WITH_CAUTION'│        │ to auth    │
  └──────────────┘        └────────────┘
```

---

## Database Operations

### Add Criminal to Database

```sql
INSERT INTO criminal_records (name, age, sex, case_number)
VALUES ('John Doe', 35, 'M', 'CASE-2023-001');
-- Returns: criminal_id = 1

INSERT INTO criminal_fingerprints (criminal_id, finger_position, template, quality_score)
VALUES (1, 'index_right', 0x<BINARY_DATA>, 85);
```

### Add Applicant to Database

```sql
INSERT INTO applicants (name, age, sex, email, clearance_status)
VALUES ('Jane Smith', 30, 'F', 'jane@example.com', 'PENDING');
-- Returns: applicant_id = 5

INSERT INTO applicant_fingerprints (applicant_id, finger_position, template, quality_score)
VALUES (5, 'index_right', 0x<BINARY_DATA>, 90);
```

### Step 1: Demographic Search

```sql
SELECT cr.* FROM criminal_records cr
WHERE LOWER(cr.name) = LOWER('Jane Smith')
  AND cr.age = 30
  AND cr.sex = 'F';
```

**Result:**
- Empty = No HIT → Approve
- Found = HIT → Proceed to Step 2

### Step 2: Fingerprint Matching (If HIT Found)

```sql
-- Get applicant's fingerprint
SELECT * FROM applicant_fingerprints 
WHERE applicant_id = 5 AND finger_position = 'index_right';

-- Get criminal's fingerprint (for matching criminal_id from Step 1)
SELECT * FROM criminal_fingerprints 
WHERE criminal_id = 1 AND finger_position = 'index_right';

-- Compare using Bozorth3 (external process)
-- bozorth3.exe applicant_template.dat criminal_template.dat
-- Returns: Score (0-100+)
```

### Record Match Result

```sql
INSERT INTO fingerprint_matches 
(applicant_id, criminal_id, finger_matched, match_score, is_match)
VALUES (5, 1, 'index_right', 48, TRUE);
-- Score 48 >= 40 → TRUE (match)
```

### Update Clearance Status

```sql
-- If no demographic hit:
UPDATE applicants SET clearance_status = 'APPROVED' WHERE id = 5;

-- If demographic hit + no fingerprint match:
UPDATE applicants SET clearance_status = 'APPROVED_WITH_CAUTION' WHERE id = 5;

-- If fingerprint match found:
UPDATE applicants SET clearance_status = 'REJECTED' WHERE id = 5;
```

---

## PHP Implementation

### Class: ApplicantInfo

```php
// Register applicant
$applicantInfo = new ApplicantInfo($pdo);
$applicantInfo->registerApplicant(
    'Jane Smith',
    30,
    'F',
    'jane@example.com'
);
// Returns: ['applicant_id' => 5]

// Submit fingerprints
$applicantInfo->submitApplicant(
    'Jane Smith',
    'jane@example.com',
    ['index_right' => ['template' => $binaryData, 'quality' => 90]]
);

// Perform two-step verification
$result = $applicantInfo->performBackgroundCheck(
    5,  // applicant_id
    'Jane Smith',  // name
    30,  // age
    'F'  // sex
);

// Returns detailed result with step 1 and step 2 info
```

### Class: FingerprintDB

```php
$db = new FingerprintDB($pdo);

// Demographic search
$hits = $db->searchCriminalByDemographics('Jane Smith', 30, 'F');
// ['hits' => [...], 'hit_count' => 1]

// If hit found, get fingerprints
$appFingerprint = $db->getApplicantFingerprints(5);
$criminalFingerprint = $db->getCriminalFingerprints($criminalIdFromHit);

// Record result
$db->recordMatchResult(5, 1, 'index_right', 48, true);

// Update status
$db->updateApplicantStatus(5, 'REJECTED');
```

### Class: Bozorth3Matcher

```php
$matcher = new Bozorth3Matcher();

// Match two fingerprints
$result = $matcher->matchTemplates(
    $appFingerprint,
    $criminalFingerprint,
    'ISO'
);
// Returns: ['score' => 48, 'match' => true/false]
```

---

## API Endpoints

### 1. Submit Applicant

**Endpoint:** `POST /applicant_info.php?action=submit`

**Request:**
```json
{
  "name": "Jane Smith",
  "age": 30,
  "sex": "F",
  "email": "jane@example.com",
  "fingerprints": {
    "index_right": {
      "template": "base64_encoded_binary",
      "quality": 90
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "applicant_id": 5,
  "applicant_name": "Jane Smith",
  "fingerprints_submitted": 1
}
```

---

### 2. Perform Background Check (Two-Step)

**Endpoint:** `POST /applicant_info.php?action=check`

**Request:**
```json
{
  "applicant_id": 5,
  "name": "Jane Smith",
  "age": 30,
  "sex": "F"
}
```

**Response (No Demographic Hit):**
```json
{
  "success": true,
  "clearance_process": "STEP_1_DEMOGRAPHIC_CHECK",
  "has_demographic_hit": false,
  "overall_risk": "low",
  "recommendation": "APPROVE",
  "message": "No matching criminal records found. Clearance APPROVED."
}
```

**Response (Demographic Hit + No Fingerprint Match):**
```json
{
  "success": true,
  "clearance_process": "TWO_STEP_VERIFICATION",
  "step_1_demographic_check": {
    "has_hit": true,
    "hits_found": 1,
    "matching_criminals": [
      {"id": 1, "name": "Jane Smith", "age": 30, "sex": "F", "case_number": "CASE-2023-001"}
    ]
  },
  "step_2_fingerprint_check": {
    "total_comparisons": 1,
    "fingerprint_matches": 0,
    "match_details": [
      {
        "criminal_id": 1,
        "applicant_finger": "index_right",
        "score": 18,
        "is_match": false
      }
    ]
  },
  "overall_risk": "low",
  "recommendation": "APPROVED_WITH_CAUTION",
  "message": "Demographic hit found but no fingerprint match. Clearance APPROVED with caution."
}
```

**Response (Fingerprint Match):**
```json
{
  "success": true,
  "clearance_process": "TWO_STEP_VERIFICATION",
  "step_1_demographic_check": {
    "has_hit": true,
    "hits_found": 1,
    "matching_criminals": [...]
  },
  "step_2_fingerprint_check": {
    "total_comparisons": 1,
    "fingerprint_matches": 1,
    "match_details": [
      {
        "criminal_id": 1,
        "applicant_finger": "index_right",
        "score": 52,
        "is_match": true
      }
    ]
  },
  "overall_risk": "high",
  "recommendation": "REJECT",
  "message": "FINGERPRINT MATCH DETECTED! Clearance REJECTED."
}
```

---

## Configuration

Edit `backend/config.php`:

```php
'thresholds' => [
    'critical_threshold' => 40,  // Score for match (REJECT)
    'warning_threshold' => 30,   // Score for warning (REVIEW)
]
```

---

## Clearance Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `PENDING` | Awaiting review | Initial state |
| `APPROVED` | No criminal hit | Process normally |
| `APPROVED_WITH_CAUTION` | Name match, different person | Manual review possible |
| `REJECTED` | Fingerprint match confirmed | Deny, escalate |

---

## Match Score Interpretation

| Score | Decision | Action |
|-------|----------|--------|
| ≥ 40 | **MATCH** | ❌ REJECT |
| 30-39 | **WARNING** | ⚠️ REVIEW |
| 20-29 | **LOW CONFIDENCE** | ✅ APPROVE |
| < 20 | **NO MATCH** | ✅ APPROVE |

---

## Testing Checklist

```
□ Register criminal with demographics
□ Register applicant with demographics
□ Test scenario 1: No demographic match
  → Should return APPROVED
  
□ Test scenario 2: Demographic match, different fingerprint
  → Should return APPROVED_WITH_CAUTION
  
□ Test scenario 3: Demographic match, matching fingerprint
  → Should return REJECTED
  
□ Verify database records created
□ Verify match history logged
□ Check clearance status updated
□ Verify all three recommendations work
```

---

## Troubleshooting

### No Demographic Match Found
**Check:**
- Name spelling matches exactly (case-insensitive search)
- Age is numeric and matches
- Sex is 'M' or 'F'
- Criminal record exists in database

### Wrong Match Score
**Check:**
- Templates are binary (not base64)
- Templates are in correct format (ISO)
- Quality score is > 50
- Bozorth3 is installed and executable

### Clearance Status Not Updating
**Check:**
- PDO connection is valid
- Database has applicants table
- applicant_id is numeric

---

## Security Considerations

✅ **Store templates encrypted** in database  
✅ **Use HTTPS** in production  
✅ **Implement authentication** for API  
✅ **Log all operations** for audit trail  
✅ **Restrict database access** by IP  
✅ **Backup regularly**  
✅ **Sanitize inputs** (prepared statements used)  

---

## Performance Tips

1. **Index on name, age, sex** for fast demographic searches
2. **Cache negative results** (no demographic hits)
3. **Batch process** multiple applicants
4. **Pre-filter by quality** score before matching
5. **Use parallel processing** for large batches

```sql
-- Create indexes for performance
CREATE INDEX idx_demographics ON criminal_records(name, age, sex);
CREATE INDEX idx_applicant_demographics ON applicants(name, age, sex);
CREATE INDEX idx_quality ON criminal_fingerprints(quality_score);
CREATE INDEX idx_quality_app ON applicant_fingerprints(quality_score);
```

---

## Complete Workflow Example

```
1. Applicant "Jane Smith" age 30, sex F submits application
   → INSERT INTO applicants

2. Applicant provides fingerprint scan
   → INSERT INTO applicant_fingerprints

3. System initiates background check
   → SELECT FROM criminal_records WHERE name='Jane Smith' AND age=30 AND sex='F'

4A. If NO HIT:
    → UPDATE applicants SET status='APPROVED'
    → Return: CLEARANCE APPROVED

4B. If HIT found (criminal "Jane Smith" age 30, sex F exists):
    → Get applicant's fingerprint template
    → Get criminal's fingerprint template
    → Execute: bozorth3 app_template.dat criminal_template.dat
    → Parse score result
    
    4B1. If Score < 40 (NO MATCH):
         → Different person! Different name matches
         → UPDATE applicants SET status='APPROVED_WITH_CAUTION'
         → Return: CLEARANCE APPROVED WITH CAUTION
    
    4B2. If Score >= 40 (MATCH):
         → Same person confirmed by biometrics!
         → This is the criminal
         → UPDATE applicants SET status='REJECTED'
         → Return: CLEARANCE REJECTED, Escalate

5. Record match result in fingerprint_matches table
   → INSERT INTO fingerprint_matches

6. Final decision made and applicant notified
```

---

**Version:** 1.0.0  
**Last Updated:** 2024-03-01  
**Status:** Production Ready
