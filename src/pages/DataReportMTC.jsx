import React from "react";

function DataReportMTC() {
  return (
    <>
      <div>
        <h1 class="text-center text-4xl antialiased hover:subpixel-antialiased; p-8">
          REPORT MAINTAINANCE
        </h1>
      </div>

      <Stack
        className="flex flex-row justify-center   "
        direction="row"
        spacing={4}
        align="center"
      >
        <div className="main">
          <h1>Search Mesin</h1>
          <div className="search">
            <input
              onChange={inputHandler}
              id="outlined-basic"
              variant="outlined"
              fullWidth
              label="Search"
              className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
          </div>
        </div>

        <div>
          <h2>Month serch</h2>
          <Select placeholder="Select Mounth" onChange={getDate}>
            <option value="1">Jan</option>
            <option value="2">Feb</option>
            <option value="3">Mar</option>
            <option value="4">Apr</option>
            <option value="5">Mei</option>
            <option value="6">Jun</option>
            <option value="7">Jul</option>
            <option value="8">Agu</option>
            <option value="9">Sep</option>
            <option value="10">Okt</option>
            <option value="11">Nov</option>
            <option value="12">Des</option>
          </Select>
        </div>

        <div>
          <h2>Line</h2>
          <Select placeholder="Select Line" onChange={doprDown}>
            <option value="Line4">FULL</option>
            <option value="Line1">Line 1</option>
            <option value="Line2">Line 2</option>
            <option value="Line3">Line 3</option>
            <option value="Line4">Line 4</option>
          </Select>
        </div>

        <div>
          <br />
          <Button
            className="w-40"
            colorScheme="blue"
            // onClick={() => {
            //   navigate(`/createnew`);
            // }}
          >
            Create New
          </Button>
        </div>
      </Stack>
      <br />
    </>
  );
}

export default DataReportMTC;
