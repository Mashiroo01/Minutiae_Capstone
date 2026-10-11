# Minutiae - Academic Fingerprint Matching System

A fingerprint identification and verification system with an academic comparison module for NIST Bozorth3, SourceAFIS, OpenAFIS, Minutia Cylinder-Code (MCC), and the Jiang minutiae matcher.

## System Overview

The Minutiae system provides:
- **Police Clearance Verification**: Two-step process for background checks
  - Step 1: Demographic screening (Name, Age, Sex matching)
  - Step 2: Fingerprint verification (Bozorth3 matching if demographic hit found)
- **Criminal Fingerprint Database**: Store and manage fingerprints of individuals with criminal records
- **Applicant Verification**: Automatic background check with recommendations
- **Bozorth3 Integration**: NIST-standard fingerprint matching algorithm
- **Independent Matcher Lab**: Compare Bozorth3, SourceAFIS, OpenAFIS, MCC, and Jiang without score fusion
- **Real Minutiae Interchange**: Convert extracted ridge endings and bifurcations to OpenAFIS CSV input
- **Match History**: Track all comparisons and clearance decisions
- **Risk Assessment**: Automatic risk evaluation and recommendations

## System Architecture

```
├── backend/                  - PHP APIs, authentication, and database access
├── config/                   - Shared matcher configuration
├── matchers/                 - Bozorth3, SourceAFIS, OpenAFIS, MCC, and Jiang adapters
├── scripts/                  - Setup, calibration, diagnostics, and scanner launchers
├── test/                     - Automated regression and integration tests
├── docs/                     - Setup, workflow, and scanner documentation
├── reports/                  - Calibration results and archived benchmarks
├── *.html / *.js             - Operator, administrator, and test interfaces
├── compose.yaml              - MariaDB and web application deployment
└── temp/                     - Re-creatable runtime files (ignored by Git)
```

See [docs/README.md](docs/README.md) for the documentation index and
[DOCKER.md](DOCKER.md) for the current local deployment instructions.

## Installation

For a containerized local setup, see [DOCKER.md](DOCKER.md). The short version
is to copy `.env.example` to `.env`, set both passwords, and run
`docker compose up --build -d`.

### 1. Install NIST NBIS Tools (Including Bozorth3)

The Bozorth3 algorithm is part of the NIST Biometric Image Software (NBIS):

**Windows:**
```powershell
# Download from NIST website
# https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis

# Extract the archive
# Navigate to the extracted folder
# Compile or extract the bozorth3.exe binary
# Copy bozorth3.exe to: C:\bozorth3\bozorth3.exe
```

**Linux/Mac:**
```bash
wget https://nist.gov/nbis/download/nist_biometric_image_software.tar.gz
tar xzf nist_biometric_image_software.tar.gz
cd nbis-master
./setup.sh
# The compiled bozorth3 will be in the output directory
```

### 2. Build the academic matcher adapters

Java 11+, Git, and Cygwin with `g++` are required. The setup command builds SourceAFIS and OpenAFIS, then downloads the Apache-2.0 `mpi-afis` reference source at pinned commit `f93e537e7b7024905ddfc7a124e9546e9dece38e` and compiles its real MCC and Jiang standalone matchers:

```powershell
npm run matchers:setup
```

The service exposes the independent comparison endpoint at `POST /afis/compare-all`. Default thresholds can be overridden with `BOZORTH3_MATCH_THRESHOLD`, `SOURCEAFIS_MATCH_THRESHOLD`, `OPENAFIS_MATCH_THRESHOLD`, `MCC_MATCH_THRESHOLD`, and `JIANG_MATCH_THRESHOLD`.

With the fingerprint service running on port 9000, verify the matcher contract,
score changes and OpenAFIS correspondences with:

```powershell
npm run matchers:verify
```

MCC uses `Ns=8` cylinders with LSSR consolidation. Jiang uses its published
nearest-neighbour local feature vectors followed by global consolidation. Both
receive the same extractor output as XYT rows containing `x`, `y`, half-degree
direction, and quality. The upstream standalone matchers return similarities in
`[0,1]`; the raw score is preserved, while `Normalized Similarity (%)` is
`clamp(raw, 0, 1) * 100`. The initial configurable threshold for each is `0.4`.
Calibrate these thresholds on the benchmark dataset before drawing accuracy or
error-rate conclusions.

Optional matcher settings:

- `MCC_EXECUTABLE` and `JIANG_EXECUTABLE`: override executable locations;
- `MCC_MATCH_THRESHOLD` and `JIANG_MATCH_THRESHOLD`: decision thresholds;
- `MCC_DISABLED=1` and `JIANG_DISABLED=1`: independently disable one matcher;
- `MPI_AFIS_TIMEOUT_MS`: standalone matcher timeout, default 30000 ms.

The upstream score interface does not expose selected pair correspondences, so
the UI explicitly reports detailed visualization as unavailable for MCC and
Jiang instead of drawing correspondence lines from another algorithm.

### 3. Update Configuration

Create your local configuration from the safe template. The resulting
`backend/config.php` is ignored by Git because it contains database and
administrator credentials.

```powershell
Copy-Item backend/config.example.php backend/config.php
```

Edit `backend/config.php`, replace every `CHANGE_ME` value with a unique
secret, and set the Bozorth3 path:

```php
'bozorth3' => [
    'path' => 'C:\\path\\to\\bozorth3.exe',  // Your actual path
    'match_threshold' => 40,
    'template_format' => 'ISO'
]
```

### 4. Create Database (MySQL)

```sql
CREATE DATABASE minutiae;
USE minutiae;

-- The FingerprintDB class will auto-create these tables
-- Or run the initialization API endpoint
```

### 5. Create Directories

```powershell
mkdir C:\xampp\htdocs\Minutiae\temp
mkdir C:\xampp\htdocs\Minutiae\logs
chmod 0755 temp logs
```

### 6. Configure Database Connection

In your PHP application, create a PDO connection:

```php
$pdo = new PDO(
    'mysql:host=localhost;dbname=minutiae',
    'root',
    'password',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$criminalRecord = new CriminalRecord($pdo);
```

## Verify Installation

### Check Bozorth3 Status

```bash
curl http://localhost/Minutiae/backend/criminal_record.php?action=status
```

Expected response:
```json
{
  "system_name": "Minutiae - Fingerprint Matching System",
  "bozorth3_status": {
    "installed": true,
    "path": "C:\\bozorth3\\bozorth3.exe",
    "message": "Bozorth3 is ready"
  },
  "database_status": {
    "connected": true,
    "message": "Connected to database"
  }
}
```

### Initialize Database

```bash
curl -X POST http://localhost/Minutiae/backend/criminal_record.php?action=init
```

## API Usage

### Register Criminal Fingerprint

```bash
curl -X POST http://localhost/Minutiae/backend/criminal_record.php?action=register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "case_number": "CASE-2024-001",
    "fingerprints": {
      "index_right": {
        "template": "<binary_template_data>",
        "format": "ISO",
        "quality": 85
      },
      "thumb_right": {
        "template": "<binary_template_data>",
        "format": "ISO",
        "quality": 80
      }
    }
  }'
```

### Submit Applicant Fingerprints

```bash
curl -X POST http://localhost/Minutiae/backend/applicant_info.php?action=submit \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Smith",
    "email": "jane@example.com",
    "fingerprints": {
      "index_right": {
        "template": "<binary_template_data>",
        "format": "ISO",
        "quality": 90
      }
    }
  }'
```

### Perform Background Check

```bash
curl -X POST http://localhost/Minutiae/backend/applicant_info.php?action=check \
  -H "Content-Type: application/json" \
  -d '{
    "applicant_id": 1,
    "name": "Jane Smith",
    "age": 28,
    "sex": "F"
  }'
```

Response example (Two-Step Verification):
```json
{
  "success": true,
  "applicant_id": 1,
  "clearance_process": "TWO_STEP_VERIFICATION",
  "step_1_demographic_check": {
    "has_hit": true,
    "hits_found": 1,
    "matching_criminals": [...]
  },
  "step_2_fingerprint_check": {
    "total_comparisons": 2,
    "fingerprint_matches": 0,
    "match_details": [...]
  },
  "overall_risk": "low",
  "recommendation": "APPROVED",
  "message": "Demographic hit found but no fingerprint match. Clearance APPROVED with caution.",
  "checked_at": "2024-03-01 10:30:00"
}
```

### Search Criminal Database

```bash
curl -X POST http://localhost/Minutiae/backend/criminal_record.php?action=search \
  -H "Content-Type: application/json" \
  -d '{
    "template": "<binary_template_data>",
    "finger": "index_right"
  }'
```

## Understanding Match Scores

The Bozorth3 algorithm returns a match score (typically 0-100+):

- **Score ≥ 40**: Definite match (CRITICAL)
- **Score 30-39**: Possible match (WARNING)
- **Score 20-29**: Low confidence match
- **Score < 20**: No meaningful match

The default threshold is set to 40, but this can be adjusted:

```php
$matcher = new Bozorth3Matcher();
$matcher->setMatchThreshold(35); // Adjust threshold
```

## Fingerprint Template Formats

Supported formats include:

- **ISO** - ISO/IEC 19794-2 (8mm minutiae)
- **ICS** - Compressed ISO format
- **FMR** - NIST Fingerprint Minutiae Record
- **WSQ** - Wavelet Scalar Quantization (image format)

The system stores templates in binary format. You'll need a fingerprint capture device or scanner to generate templates.

## Using with Fingerprint Scanners

To integrate with physical fingerprint scanners:

1. **Capture fingerprint** using your scanner's SDK
2. **Extract minutiae** - Generate ISO or ICS template
3. **Submit to API** - Send binary template to the system
4. **Get results** - Receive match scores and recommendations

Example integration with a scanner device:

```php
// Pseudo-code for scanner integration
$scanner = new FingerprintScanner();
$scanner->startCapture();

// User places finger on scanner
$image = $scanner->getImage();

// Extract minutiae to ISO template
$template = $scanner->extractTemplate($image, 'ISO');

// Submit to Minutiae system
$data = [
    'name' => 'John Doe',
    'fingerprints' => [
        'index_right' => [
            'template' => base64_encode($template),
            'quality' => 85
        ]
    ]
];

// Send to API
```

## Database Schema

### criminal_fingerprints Table
```
- id (INT, PRIMARY KEY)
- criminal_id (INT, FOREIGN KEY)
- finger_position (VARCHAR 50)
- template (LONGBLOB)
- template_format (VARCHAR 20)
- quality_score (INT)
- captured_at (TIMESTAMP)
```

### applicant_fingerprints Table
```
- id (INT, PRIMARY KEY)
- applicant_id (INT, FOREIGN KEY)
- finger_position (VARCHAR 50)
- template (LONGBLOB)
- template_format (VARCHAR 20)
- quality_score (INT)
- submitted_at (TIMESTAMP)
```

### fingerprint_matches Table
```
- id (INT, PRIMARY KEY)
- applicant_id (INT)
- criminal_id (INT)
- finger_matched (VARCHAR 50)
- match_score (INT)
- is_match (BOOLEAN)
- matched_at (TIMESTAMP)
```

## Risk Assessment Logic

The system automatically assigns risk levels based on match results:

```
HIGH RISK:
├─ If any positive match found (score ≥ threshold)
├─ Recommendation: REJECT
└─ Action: Manual review required

MEDIUM RISK:
├─ If warnings detected (score 30-39)
├─ Recommendation: REVIEW  
└─ Action: Additional verification needed

LOW RISK:
├─ If no matches found
├─ Recommendation: APPROVE
└─ Action: Standard processing
```

## Troubleshooting

### Bozorth3 Not Found
```php
$matcher = new Bozorth3Matcher();
$status = $matcher->getStatus();
// Check: $status['installed'] === false
// Solution: Update bozorth3 path in config.php
```

### Template Format Errors
- Ensure templates are in the correct binary format
- ISO format requires proper header and structure
- Use NIST-compliant fingerprint extraction tools

### Database Connection Issues
- Verify MySQL is running
- Check credentials in config.php
- Ensure database 'minutiae' exists
- Run initialization: `POST /criminal_record.php?action=init`

### Match Threshold Too Strict/Loose
- Adjust threshold in config.php
- Typical range: 30-50
- Lower = more matches, higher = fewer matches
- Test with known fingerprints to calibrate

## Performance Notes

- Bozorth3 matching is computationally intensive
- For large database searches (1000+ records), consider:
  - Parallel processing
  - Indexing by finger position
  - Pre-filtering by quality score
  - Batch processing API

## Security Considerations

- Store templates securely (encrypted in database)
- Use HTTPS in production
- Implement API authentication for sensitive operations
- Log all match operations and results
- Regular backups of fingerprint database
- Audit trail for compliance

## Production Deployment Checklist

- [ ] Bozorth3 compiled and executable
- [ ] Database configured and initialized
- [ ] SSL/HTTPS enabled
- [ ] Proper file permissions on temp/logs directories
- [ ] API authentication implemented
- [ ] Logging configured
- [ ] Error handling and monitoring in place
- [ ] Database backups scheduled
- [ ] Regular testing with known fingerprints
- [ ] Compliance documentation reviewed

## Support and Documentation

- NIST NBIS: https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis
- ISO/IEC 19794-2: Fingerprint Minutiae Data Format
- Bozorth3 Algorithm Papers: NIST publications

## License

This system integrates NIST Bozorth3 algorithm. Please review NIST software licensing requirements.

## Changelog

### v1.0.0 (2024-03-01)
- Initial implementation
- Bozorth3 integration complete
- Database schema established
- API endpoints functional
- Risk assessment logic implemented
