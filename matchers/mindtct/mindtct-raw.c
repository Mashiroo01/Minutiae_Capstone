#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

#include <lfs.h>

static int parse_positive_int(const char *text, const char *name)
{
    char *end = NULL;
    long value;
    errno = 0;
    value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > 100000) {
        fprintf(stderr, "Invalid %s: %s\n", name, text);
        exit(2);
    }
    return (int)value;
}

int main(int argc, char **argv)
{
    FILE *input;
    unsigned char *pixels = NULL;
    unsigned char *binary = NULL;
    MINUTIAE *minutiae = NULL;
    int *quality_map = NULL;
    int *direction_map = NULL;
    int *low_contrast_map = NULL;
    int *low_flow_map = NULL;
    int *high_curve_map = NULL;
    int map_w = 0, map_h = 0;
    int binary_w = 0, binary_h = 0, binary_depth = 0;
    int width, height, ppi, result, index;
    size_t pixel_count;

    if (argc != 5) {
        fprintf(stderr, "Usage: %s <raw-grayscale> <width> <height> <ppi>\n", argv[0]);
        return 2;
    }

    width = parse_positive_int(argv[2], "width");
    height = parse_positive_int(argv[3], "height");
    ppi = parse_positive_int(argv[4], "ppi");
    pixel_count = (size_t)width * (size_t)height;
    if (pixel_count / (size_t)width != (size_t)height) {
        fprintf(stderr, "Image dimensions overflow.\n");
        return 2;
    }

    input = fopen(argv[1], "rb");
    if (input == NULL) {
        fprintf(stderr, "Unable to open raw image: %s\n", argv[1]);
        return 3;
    }
    pixels = (unsigned char *)malloc(pixel_count);
    if (pixels == NULL) {
        fclose(input);
        fprintf(stderr, "Unable to allocate raw image buffer.\n");
        return 4;
    }
    if (fread(pixels, 1, pixel_count, input) != pixel_count || fgetc(input) != EOF) {
        fclose(input);
        free(pixels);
        fprintf(stderr, "Raw image size does not match width and height.\n");
        return 5;
    }
    fclose(input);

    result = get_minutiae(
        &minutiae, &quality_map, &direction_map, &low_contrast_map,
        &low_flow_map, &high_curve_map, &map_w, &map_h,
        &binary, &binary_w, &binary_h, &binary_depth,
        pixels, width, height, 8, ppi / 25.4, &lfsparms_V2
    );
    free(pixels);
    if (result != 0) {
        fprintf(stderr, "MINDTCT get_minutiae failed with code %d.\n", result);
        return result > 0 ? result : 6;
    }

    for (index = 0; index < minutiae->num; index++) {
        const MINUTIA *item = minutiae->list[index];
        int nist_x, nist_y, nist_direction;
        lfs2nist_minutia_XYT(&nist_x, &nist_y, &nist_direction, item, width, height);
        printf("%d %d %d %.8f %d\n",
            nist_x, nist_y, nist_direction, item->reliability, item->type);
    }

    free_minutiae(minutiae);
    free(quality_map);
    free(direction_map);
    free(low_contrast_map);
    free(low_flow_map);
    free(high_curve_map);
    free(binary);
    return 0;
}
