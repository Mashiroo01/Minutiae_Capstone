import java.nio.file.Files;
import java.nio.file.Path;

import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;

/**
 * Minimal command-line bridge around the official SourceAFIS Java API.
 *
 * Output is deliberately a single JSON object so the Node service can isolate
 * this matcher in its own child process.
 */
public final class SourceAfisCli {
    private SourceAfisCli() {
    }

    public static void main(String[] args) {
        if (args.length < 2 || args.length > 4) {
            fail("Usage: SourceAfisCli <probe-image> <reference-image> [probe-dpi] [reference-dpi]");
        }

        try {
            double probeDpi = args.length >= 3 ? Double.parseDouble(args[2]) : 500.0;
            double referenceDpi = args.length >= 4 ? Double.parseDouble(args[3]) : probeDpi;
            byte[] probeBytes = Files.readAllBytes(Path.of(args[0]));
            byte[] referenceBytes = Files.readAllBytes(Path.of(args[1]));
            FingerprintTemplate probe = new FingerprintTemplate(new FingerprintImage(
                probeBytes, new FingerprintImageOptions().dpi(probeDpi)));
            FingerprintTemplate reference = new FingerprintTemplate(new FingerprintImage(
                referenceBytes, new FingerprintImageOptions().dpi(referenceDpi)));
            double score = new FingerprintMatcher(probe).match(reference);

            if (!Double.isFinite(score)) {
                fail("SourceAFIS returned a non-finite score.");
            }
            System.out.printf(java.util.Locale.ROOT,
                "{\"score\":%.12f,\"probeDpi\":%.2f,\"referenceDpi\":%.2f,\"probeTemplateCreated\":true,\"referenceTemplateCreated\":true}%n",
                score, probeDpi, referenceDpi);
        } catch (Throwable error) {
            fail(error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
        }
    }

    private static void fail(String message) {
        System.err.println(message == null ? "Unknown SourceAFIS error." : message);
        System.exit(1);
    }
}
