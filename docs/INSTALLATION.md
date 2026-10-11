# Bozorth3 Integration - Installation Guide

## What Was Created

Your Minutiae fingerprint system now includes complete Bozorth3 integration with the following components:

### Core Integration Files:
1. **Bozorth3Matcher.php** - Wrapper class for Bozorth3 algorithm
2. **FingerprintDB.php** - Database abstraction layer for fingerprint storage
3. **criminal_record.php** - Criminal records management API
4. **criminal_info.php** - Criminal fingerprint handling
5. **applicant_info.php** - Applicant fingerprint submission and background checks
6. **config.php** - System configuration file
7. **README.md** - Comprehensive documentation
8. **QUICKSTART.php** - Quick start guide and examples

## Installing Bozorth3

### Option 1: Download Precompiled (Windows)

1. Visit: https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis
2. Download the Windows version
3. Extract the archive
4. Look for `bozorth3.exe` in the extracted folder
5. Copy `bozorth3.exe` to: `C:\bozorth3\bozorth3.exe`
6. Update `config.php` with this path

### Option 2: Compile from Source (Linux/Mac)

```bash
# Download source
wget https://nist.gov/nbis/download/nist_biometric_image_software.tar.gz
tar xzf nist_biometric_image_software.tar.gz
cd nbis-master

# Compile
./setup.sh
make

# Compiled binary will be in the output directory
# Copy to your system path
cp output/bin/bozorth3 /usr/local/bin/
```

### Option 3: Using Docker

```dockerfile
FROM ubuntu:latest

RUN apt-get update && apt-get install -y \
    build-essential \
    autoconf \
    libtool

WORKDIR /nbis
RUN wget https://nist.gov/nbis/download/nist_biometric_image_software.tar.gz && \
    tar xzf nist_biometric_image_software.tar.gz && \
    cd nbis-master && \
    ./setup.sh && \
    make

RUN cp nbis-master/output/bin/bozorth3 /usr/local/bin/
```

## Verifying Installation

### 1. Test Bozorth3 Command

```bash
# Windows
C:\bozorth3\bozorth3.exe

# Linux/Mac
bozorth3
```

You should see usage information or no error.

### 2. Check System Status via PHP

Visit: `http://localhost/Minutiae/QUICKSTART.php`

Or check via API:
```bash
curl http://localhost/Minutiae/backend/criminal_record.php?action=status
```

Look for:
```json
"bozorth3_status": {
  "installed": true,
  "message": "Bozorth3 is ready"
}
```

## System Architecture

```
Fingerprint Input (Scanner/Capture)
         ↓
   Extract Minutiae (ISO Template)
         ↓
   Submit to API (applicant_info.php)
         ↓
   Store in Database (applicant_fingerprints)
         ↓
   Retrieve Criminal Templates (criminal_fingerprints)
         ↓
   Bozorth3Matcher.matchTemplates()
         ↓
   Bozorth3 Algorithm (external process)
         ↓
   Match Score (0-100+)
         ↓
   Risk Assessment Logic
         ↓
   APPROVE/REJECT/REVIEW
```

## Key API Endpoints

### Check Status
```bash
GET /backend/criminal_record.php?action=status
```

### Register Criminal
```bash
POST /backend/criminal_record.php?action=register
Content-Type: application/json

{
  "name": "John Doe",
  "case_number": "CASE-2024-001",
  "fingerprints": {
    "index_right": {
      "template": "base64_encoded_binary_data",
      "format": "ISO",
      "quality": 85
    }
  }
}
```

### Submit Applicant
```bash
POST /backend/applicant_info.php?action=submit
Content-Type: application/json

{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "fingerprints": {
    "index_right": {
      "template": "base64_encoded_binary_data",
      "format": "ISO",
      "quality": 90
    }
  }
}
```

### Background Check
```bash
POST /backend/applicant_info.php?action=check
Content-Type: application/json

{
  "applicant_id": 1
}
```

Response:
```json
{
  "success": true,
  "overall_risk": "low|medium|high",
  "recommendation": "APPROVE|REVIEW|REJECT",
  "positive_matches": 0,
  "match_results": [...]
}
```

## Database Setup

The system will automatically create necessary tables:

- `criminal_fingerprints` - Criminal fingerprint records
- `applicant_fingerprints` - Applicant fingerprint records
- `fingerprint_matches` - Match history and results
- `criminal_records` - Criminal info
- `applicants` - Applicant info

Initialize via API:
```bash
POST /backend/criminal_record.php?action=init
```

## Configuration

Edit `backend/config.php` to customize:

```php
// Bozorth3 path
'bozorth3' => [
    'path' => 'C:\\bozorth3\\bozorth3.exe',
    'match_threshold' => 40,  // Adjust sensitivity
    'template_format' => 'ISO'
]

// Database credentials
'database' => [
    'host' => 'localhost',
    'user' => 'root',
    'password' => '',
    'database' => 'minutiae'
]

// Match thresholds
'thresholds' => [
    'critical_threshold' => 40,
    'warning_threshold' => 30
]
```

## Fingerprint Template Guide

### Supported Formats
- **ISO** - ISO/IEC 19794-2 (8mm minutiae) ✓ RECOMMENDED
- **ICS** - Compressed ISO format
- **FMR** - NIST Fingerprint Minutiae Record
- **WSQ** - Wavelet Scalar Quantization (for images)

### Obtaining Templates

1. **Use a Fingerprint Scanner SDK**:
   - Suprema BioMini
   - Futronic FS80H
   - Secugen Hamster IV
   - etc.

2. **Extract Minutiae**:
   ```python
   # Example: Using a NIST-compliant extractor
   template = scanner.capture_and_extract(format='ISO')
   ```

3. **Encode and Submit**:
   ```python
   import base64
   encoded = base64.b64encode(template).decode()
   # Send in API request
   ```

## Match Score Interpretation

| Score | Interpretation | Action |
|-------|----------------|--------|
| ≥ 40 | Definite Match | REJECT |
| 30-39 | Possible Match | REVIEW |
| 20-29 | Low Confidence | APPROVE with caution |
| < 20 | No Match | APPROVE |

## Troubleshooting

### Bozorth3 Not Found
```
Error: "Bozorth3 not found at: C:\bozorth3\bozorth3.exe"
```
**Solution**: 
- Verify bozorth3.exe exists at the path
- Update path in config.php
- Ensure file is executable (chmod +x on Linux/Mac)

### Database Connection Error
```
Error: "Database connection not available"
```
**Solution**:
- Check MySQL is running
- Verify credentials in config.php
- Run initialization endpoint

### Invalid Template Format
```
Error: "Template parsing failed"
```
**Solution**:
- Ensure template is in specified format (ISO)
- Extract properly from scanner
- Check template is binary data (not text)

### Poor Match Results
**Solutions**:
- Adjust match_threshold in config.php
- Verify template quality (should be > 50)
- Test with known matching fingerprints
- Check Bozorth3 version compatibility

## Performance Tips

1. **For Large Databases**:
   - Index by finger position
   - Filter by quality score first
   - Consider parallel processing

2. **Optimize Database**:
   ```sql
   CREATE INDEX idx_finger ON criminal_fingerprints(finger_position);
   CREATE INDEX idx_quality ON applicant_fingerprints(quality_score);
   ```

3. **Caching**:
   - Cache frequent criminal searches
   - Implement Redis for template caching
   - Pre-process templates

## Security Checklist

- [ ] HTTPS enabled in production
- [ ] API authentication implemented
- [ ] Logging enabled and rotated
- [ ] Database encrypted
- [ ] File permissions restricted
- [ ] Regular backups scheduled
- [ ] Audit trail enabled
- [ ] Error messages sanitized

## Next Steps

1. **Install Bozorth3** (using guide above)
2. **Configure Database** (update credentials)
3. **Test Installation** (visit QUICKSTART.php)
4. **Integrate Scanner** (get templates from device)
5. **Deploy to Production** (follow checklist)

## Support Resources

- NIST NBIS: https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis
- Bozorth3 Papers: https://nvlpubs.nist.gov/
- ISO/IEC 19794-2: Fingerprint Minutiae Format
- NIST Biometric Standards: https://www.nist.gov/programs/biometric-standards

## License Notes

- Bozorth3: NIST Public Domain Software
- This integration: Follows NIST licensing
- For commercial use, review NIST software terms

---

**System Status**: Ready for Bozorth3 Installation
**Last Updated**: 2024-03-01
**Version**: 1.0.0
