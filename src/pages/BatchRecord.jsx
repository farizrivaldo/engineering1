import { React, useState, useEffect } from "react";
import { Stack, Select } from "@chakra-ui/react";
import axios from "axios";

function BatchRecord() {
  const [fetchLineData, setFetchLineData] = useState([]);
  const [fetchProcesData, setFetchProcesData] = useState([]);
  const [fetchMachineData, setFetchMachineData] = useState([]);
  const [newLine, setNewLine] = useState("");
  const [newProces, setNewProces] = useState("");
  const [newMachine, setNewMachine] = useState("");

  const fetchLine = async () => {
    let response = await axios.get("http://10.126.15.141:8002/part/lineData");
    setFetchLineData(response.data);
  };

  const fetchProces = async (line) => {
    let response = await axios.get(
      "http://10.126.15.141:8002/part/procesData",
      {
        params: {
          line_name: line,
        },
      }
    );

    setFetchProcesData(response.data);
  };

  const fetchMachine = async (line, proces) => {
    let response = await axios.get(
      "http://10.126.15.141:8002/part/machineData",
      {
        params: {
          line_name: line,
          proces_name: proces,
        },
      }
    );
    setFetchMachineData(response.data);
  };

  const renderLine = () => {
    return fetchLineData.map((lineCategory) => {
      return (
        <option value={lineCategory.line_name}>{lineCategory.line_name}</option>
      );
    });
  };

  const renderProces = () => {
    return fetchProcesData.map((procesCategory) => {
      return (
        <option value={procesCategory.proces_name}>
          {procesCategory.proces_name}
        </option>
      );
    });
  };

  const renderMachine = () => {
    return fetchMachineData.map((machineCategory) => {
      return (
        <option value={machineCategory.machine_name}>
          {machineCategory.machine_name}
        </option>
      );
    });
  };

  //========================HENDELER========================================
  const lineHendeler = (event) => {
    setNewLine(event.target.value);
    fetchProces(event.target.value);
    //console.log(event.target.value);
  };

  const procesHendeler = (event) => {
    setNewProces(event.target.value);
    fetchMachine(newLine, event.target.value);
    //console.log(event.target.value);
  };

  const machineHendeler = (event) => {
    setNewMachine(event.target.value);
    //console.log(event.target.value);
  };

  useEffect(() => {
    fetchLine();
  }, []);

  return (
    <>
      <h1 className="text-center text-4xl antialiased hover:subpixel-antialiased p-8">
        BATCH RECORD
      </h1>
      <div className="pb-12 border-solid border-4 mt-2 ">
        <div className="flex flex-auto mt-2 gap-x-6 gap-y-8 p-4  sm:grid-cols-6   ">
          <Stack
            className="flex flex-col justify-center   "
            direction="row"
            spacing={4}
            align="center"
          >
            <div className="main">
              <h1>Search Batch</h1>
              <div className="search">
                <input
                  id="outlined-basic"
                  variant="outlined"
                  fullWidth
                  label="Search"
                  className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                />
              </div>
              <div className="sm:col-span-4">
                <label
                  htmlFor="username"
                  className="block text-sm font-medium leading-6 text-gray-900"
                >
                  Line Area
                </label>
                <div className="mt-2 ">
                  <Select
                    placeholder="Select Line"
                    id="line"
                    onChange={lineHendeler}
                  >
                    {renderLine()}
                  </Select>
                </div>
              </div>
              <div className="sm:col-span-4 ">
                <label
                  htmlFor="username"
                  className="block text-sm font-medium leading-6 text-gray-900"
                >
                  Proces
                </label>
                <div className="mt-2 ">
                  <Select
                    placeholder="Select Machine"
                    onChange={procesHendeler}
                  >
                    {renderProces()}
                  </Select>
                </div>
              </div>

              <div className="sm:col-span-4">
                <label
                  htmlFor="username"
                  className="block text-sm font-medium leading-6 text-gray-900"
                >
                  Machine
                </label>
                <div className="mt-2 ">
                  <Select
                    placeholder="Select Machine"
                    onChange={machineHendeler}
                  >
                    {renderMachine()}
                  </Select>
                </div>
              </div>
            </div>
          </Stack>
        </div>
      </div>
    </>
  );
}

export default BatchRecord;
