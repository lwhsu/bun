if(CMAKE_COLOR_DIAGNOSTICS)
  set(ESBUILD_ARGS --color)
endif()

if(BUN_BOOTSTRAP_CODEGEN_NODE)
  find_program(SYSTEM_ESBUILD_EXECUTABLE NAMES esbuild REQUIRED)
  setx(ESBUILD_EXECUTABLE ${SYSTEM_ESBUILD_EXECUTABLE})
else()
  if(CMAKE_HOST_WIN32)
    setx(ESBUILD_EXECUTABLE ${CWD}/node_modules/.bin/esbuild.exe)
  else()
    setx(ESBUILD_EXECUTABLE ${CWD}/node_modules/.bin/esbuild)
  endif()

  register_command(
    COMMAND
      ${BUN_EXECUTABLE}
        install
        --frozen-lockfile
    SOURCES
      ${CWD}/package.json
    OUTPUTS
      ${ESBUILD_EXECUTABLE}
  )
endif()
