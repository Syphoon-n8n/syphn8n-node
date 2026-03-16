const gulp = require('gulp');

gulp.task('build:icons', function () {
  return gulp
    .src(['nodes/**/icon.svg', 'credentials/**/icon.svg'])
    .pipe(gulp.dest('dist'));
});

gulp.task('default', gulp.series('build:icons'));
